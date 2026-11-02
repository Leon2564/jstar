-- v1.1 (#62): the weather in her city and, if he chose one, in his. Mirrors WeatherRow and UserCityRow in
-- src/db/types.ts; the rules (refresh, staleness, warnings, first snow) are in packages/shared/src/weather.ts.

-- One row per weather point, refreshed about hourly by the tick (src/jobs/refreshWeather.ts). Her cities are keyed
-- by city id ('nagano'), a user's city by its 0.1° square ('ll:25.1,121.5'), shared by everyone in it. A failed
-- fetch keeps `data` and `fetched_at` and only records the error, so the last good weather is still there (stale
-- after 3 hours). Holds no personal data: a square nobody chose any more is deleted by the next tick.
CREATE TABLE weather (
  city_key   TEXT PRIMARY KEY,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  fetched_at TEXT,                 -- last successful fetch; NULL until the first one
  tried_at   TEXT NOT NULL,        -- last attempt, successful or not
  error      TEXT,                 -- why the last attempt failed; NULL after a success
  data       TEXT                  -- JSON WeatherData; NULL until the first success
);

-- 初雪: the first snow of each snow season (JMA 寒候年, August–July, named after the year it ends) at a point,
-- recorded once: the primary key makes a second snowy fetch in the same season a no-op.
CREATE TABLE weather_first_snow (
  city_key TEXT NOT NULL,
  winter   INTEGER NOT NULL,
  day      TEXT NOT NULL,          -- local calendar day, YYYY-MM-DD
  PRIMARY KEY (city_key, winter)
);

-- His own city, optional (My page). City level only: the place name and its position rounded to 0.1° (~11 km),
-- never an address or the device's location. Used for the weather only; deleted when he clears it and with the
-- account (users.anonymise). docs/compliance-jp.md §7.1.
CREATE TABLE user_cities (
  user_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_user_cities_point ON user_cities(lat, lon);
