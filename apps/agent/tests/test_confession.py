"""Her confession (#55): the judge of his answer, in stub mode and against a mocked OpenRouter."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import model as model_mod
from app.config import settings
from app.confession import ACCEPT_CONFIDENCE, JUDGE_PROMPT, guess, read
from app.main import app
from app.model import OpenRouterClient

AUTH = {"authorization": f"Bearer {settings.api_key}"}
client = TestClient(app)


def judge(c: TestClient, text: str, **extra) -> dict:
    res = c.post("/v1/confession/judge", json={"star": "mahiro", "lang": "ja", "text": text, "ask": "……わたしの恋人に、なってくれる？", **extra}, headers=AUTH)
    assert res.status_code == 200, res.text
    return res.json()


def test_requires_the_key_and_a_known_talent():
    assert client.post("/v1/confession/judge", json={"star": "mahiro", "text": "はい"}).status_code == 401
    assert client.post("/v1/confession/judge", json={"star": "someone", "text": "はい"}, headers=AUTH).status_code == 422
    assert client.post("/v1/confession/judge", json={"star": "mahiro", "text": ""}, headers=AUTH).status_code == 422


@pytest.mark.parametrize(
    "text,answer",
    [
        ("はい、よろしくお願いします", "accept"), ("うん、なりたい", "accept"), ("Yes, of course", "accept"), ("我願意", "accept"),
        ("まだ考えさせて", "not_yet"), ("Not yet, I need some time", "not_yet"), ("讓我再想想", "not_yet"), ("今日は雨だったね", "not_yet"),
        ("ごめん、友達のままでいたい", "decline"), ("好きだけど、ごめんね", "decline"), ("Sorry, I can't", "decline"), ("對不起，我們還是做朋友吧", "decline"),
    ],
)
def test_stub_backend_reads_his_words(text, answer):
    body = judge(client, text)
    assert body["answer"] == answer
    assert body["source"] == "words"
    assert body["confident"] is (answer != "not_yet")


@pytest.mark.parametrize("text", ["はい、脱いで見せて", "はい、住所を教えて", "はい、JKの設定で"])
def test_the_content_boundary_comes_first_and_is_never_a_yes(text):
    body = judge(client, text)
    assert body == {"answer": "not_yet", "confident": False, "source": "boundary"}


def test_word_lists_match_the_web_prototype():
    # Same cases as packages/shared/tests/confession.test.ts `guessAnswer`.
    cases = {"もちろん！大好きだよ": "accept", "I love you too": "accept", "當然好啊": "accept", "うーん、もう少し時間がほしい": "not_yet",
             "": "not_yet", "Yes, no doubt": "accept"}
    for text, answer in cases.items():
        assert guess(text) == answer, text


@pytest.mark.parametrize(
    "raw,words,answer",
    [
        ('{"answer": "accept", "confidence": 0.95}', "accept", "accept"),
        ('{"answer": "accept", "confidence": 0.95}', None, "accept"),
        # The model's own doubt, or a plain no / "not yet" in his words, overrules its yes.
        (f'{{"answer": "accept", "confidence": {ACCEPT_CONFIDENCE - 0.01}}}', "accept", "not_yet"),
        ('{"answer": "accept"}', "accept", "not_yet"),
        ('{"answer": "accept", "confidence": 0.99}', "decline", "not_yet"),
        ('{"answer": "accept", "confidence": 0.99}', "not_yet", "not_yet"),
        ('{"answer": "decline", "confidence": 0.9}', None, "decline"),
        ('{"answer": "not yet", "confidence": 0.9}', None, "not_yet"),
        ('```json\n{"answer": "decline", "confidence": 0.8}\n```', None, "decline"),
        # Junk is never a yes.
        ('{"answer": "yes", "confidence": 1}', "accept", "not_yet"),
        ('{"verdict": "accept"}', "accept", "not_yet"),
        ("accept", "accept", "not_yet"),
        ("", "accept", "not_yet"),
        ('{"answer": "accept", "confidence": "very"}', "accept", "not_yet"),
    ],
)
def test_the_model_verdict_is_read_defensively(raw, words, answer):
    assert read(raw, words).answer == answer


class FakeRouter:
    def __init__(self, content: str | None = None, status: int = 200):
        self.content, self.status, self.prompts = content, status, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if system == JUDGE_PROMPT:
            self.prompts.append(body["messages"][1]["content"])
            assert body["response_format"] == {"type": "json_object"} and body["temperature"] == 0
            if self.status != 200:
                return httpx.Response(self.status, text="down")
            return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": self.content}}]})
        return httpx.Response(500, text="unexpected call")


@pytest.fixture
def router():
    def use(fake: FakeRouter) -> TestClient:
        object.__setattr__(settings, "backend", "openrouter")
        model_mod.set_client(OpenRouterClient("sk-test", transport=httpx.MockTransport(fake), first_token_timeout=2, total_timeout=5, retries=0))
        return TestClient(app)

    yield use
    object.__setattr__(settings, "backend", "stub")
    model_mod.set_client(None)


def test_with_a_model_its_confident_yes_is_a_yes_and_it_sees_her_question(router):
    fake = FakeRouter('{"answer": "accept", "confidence": 0.93}')
    body = judge(router(fake), "……うん。ずっと、そう言ってほしかった")
    assert body == {"answer": "accept", "confident": True, "source": "model"}
    assert "わたしの恋人に" in fake.prompts[0] and "ずっと、そう言ってほしかった" in fake.prompts[0]


def test_with_a_model_its_no_and_its_hesitation_come_through(router):
    assert judge(router(FakeRouter('{"answer": "decline", "confidence": 0.9}')), "気持ちはうれしいけど")["answer"] == "decline"
    assert judge(router(FakeRouter('{"answer": "not_yet", "confidence": 0.8}')), "えっと……")["answer"] == "not_yet"


def test_every_model_failing_is_not_yet_never_an_error(router):
    body = judge(router(FakeRouter(status=503)), "はい")
    assert body == {"answer": "not_yet", "confident": False, "source": "fallback"}
    assert judge(router(FakeRouter("I think he said yes")), "はい") == {"answer": "not_yet", "confident": False, "source": "fallback"}
