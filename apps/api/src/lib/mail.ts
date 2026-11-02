import type { Lang } from '@jstar/shared';
import { env } from '../env';

export interface OtpMail { to: string; code: string; lang: Lang; ttlMinutes: number }
export type Mailer = (m: OtpMail) => Promise<void>;

const COPY: Record<'ja' | 'zh-Hant' | 'en', { subject: string; lines: (code: string, ttl: number) => string[] }> = {
  ja: {
    subject: 'JSTAR 確認コード',
    lines: (code, ttl) => [`JSTAR の確認コードは ${code} です。`, `${ttl}分以内に画面に入力してください。`, 'お心当たりがない場合は、このメールを破棄してください。']
  },
  'zh-Hant': {
    subject: 'JSTAR 驗證碼',
    lines: (code, ttl) => [`你的 JSTAR 驗證碼是 ${code}。`, `請在 ${ttl} 分鐘內輸入。`, '如果這不是你本人的操作，請忽略此郵件。']
  },
  en: {
    subject: 'Your JSTAR code',
    lines: (code, ttl) => [`Your JSTAR verification code is ${code}.`, `Enter it within ${ttl} minutes.`, "If you didn't ask for it, you can ignore this email."]
  }
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The sign-in code e-mail, in the visitor's language (Korean and anything else fall back to Japanese). */
export function otpMail(m: OtpMail): { to: string; subject: string; text: string; html: string } {
  const copy = COPY[m.lang as keyof typeof COPY] ?? COPY.ja;
  const lines = copy.lines(m.code, m.ttlMinutes);
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f4eef2;font-family:system-ui,sans-serif;color:#24284d">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:6px;padding:32px 28px">
<p style="margin:0 0 20px;letter-spacing:.3em;font-size:14px">&#10022; JSTAR</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.8">${escape(lines[0])}</p>
<p style="margin:0 0 20px;font-size:32px;letter-spacing:.35em;font-weight:600">${escape(m.code)}</p>
<p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#5b5f7f">${escape(lines[1])}</p>
<p style="margin:0;font-size:12px;line-height:1.8;color:#8a8ca3">${escape(lines[2])}</p>
</div></body></html>`;
  return { to: m.to, subject: copy.subject, text: lines.join('\n\n'), html };
}

/** Sends through the Worker's Email Service binding (MAIL_URL, answered by infra/cloudflare). */
export const sendOtpMail: Mailer = async (m) => {
  if (!env.MAIL_URL) throw Object.assign(new Error('mail_not_configured'), { statusCode: 503 });
  let res: Response;
  try {
    res = await fetch(`${env.MAIL_URL}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otpMail(m)), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw Object.assign(new Error('mail_unavailable', { cause: e }), { statusCode: 503 });
  }
  if (!res.ok) throw Object.assign(new Error('mail_unavailable', { cause: `http_${res.status}` }), { statusCode: 503 });
};
