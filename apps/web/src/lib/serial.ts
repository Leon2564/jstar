/**
 * Serial-code helpers live in @jstar/shared so the web app, the API and the admin
 * console can never disagree about what a valid code looks like.
 */
export {
  DEMO_SERIALS, SERIAL_LENGTH, SERIAL_RE, formatSerial, isValidSerialFormat, luhnCheckDigit, normalizeSerial, serialFromPath, serialFromQuery
} from '@jstar/shared/serial';
