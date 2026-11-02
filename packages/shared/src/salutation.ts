/**
 * A salutation for another part of the day (N-38: 「おはよー！」 at 14:15; N-42: 「おはよう」 on a night alarm), as the
 * persona service checks it (persona.py SALUTATIONS): its name, or null when the line fits the hour. `at` is a moment
 * (her hour in Japan is read from it) or an hour of the day already on someone's clock (0–23).
 */
const SALUTATIONS: [string, RegExp, [number, number]][] = [
  ['good morning', /おはよ|good\s*morning|^\W*morning\b|좋은\s*아침|早安|早上好/im, [4, 11]],
  ['good night', /おやすみ(?!の|日|中)|good\s*night|goodnight|night[\s-]night|잘\s?자(?:요)?(?=[\s!.~…?,]|$)|晚安/im, [20, 4]],
  ['good evening', /こんばんは|こんばんわ|good\s*evening|좋은\s*저녁|晚上好/i, [17, 4]],
  ['good afternoon', /こんにちは|good\s*afternoon|午安/i, [10, 18]]
];

export function wrongTimeSalutation(text: string, at: Date | number = new Date()): string | null {
  const h = typeof at === 'number' ? at : (at.getUTCHours() + 9) % 24;
  for (const [name, re, [start, end]] of SALUTATIONS) {
    const fits = start < end ? h >= start && h < end : h >= start || h < end;
    if (re.test(text) && !fits) return name;
  }
  return null;
}
