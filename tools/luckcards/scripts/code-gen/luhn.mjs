/** 12 位码的校验位算法，生成与校验共用一份实现。 */

export function luhnCheckDigit(digits) {
  let sum = 0;
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let d = digits[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidCode(code) {
  if (!/^[1-9][0-9]{11}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  return luhnCheckDigit(digits.slice(0, 11)) === digits[11];
}
