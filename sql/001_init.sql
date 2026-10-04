CREATE DATABASE IF NOT EXISTS seatres CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE seatres;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  token VARCHAR(128) NOT NULL UNIQUE,
  display_name VARCHAR(64) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shows (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(128) NOT NULL UNIQUE,
  price_paise INT UNSIGNED NOT NULL,
  per_user_limit SMALLINT UNSIGNED NOT NULL DEFAULT 4,
  total_seats INT UNSIGNED NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS seats (
  show_id VARCHAR(32) NOT NULL,
  seat_id VARCHAR(16) NOT NULL,
  status ENUM('available','held','confirmed') NOT NULL DEFAULT 'available',
  user_id BIGINT NULL,
  reservation_id VARCHAR(32) NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (show_id, seat_id),
  INDEX idx_show_user (show_id, user_id),
  CONSTRAINT fk_seats_show FOREIGN KEY (show_id) REFERENCES shows(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reservations (
  id VARCHAR(32) PRIMARY KEY,
  show_id VARCHAR(32) NOT NULL,
  user_id BIGINT NOT NULL,
  idem_key VARCHAR(128) NOT NULL,
  body_hash CHAR(64) NOT NULL,
  amount_paise INT UNSIGNED NOT NULL,
  status ENUM('confirmed','cancelled') NOT NULL DEFAULT 'confirmed',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at TIMESTAMP(3) NULL,
  UNIQUE KEY uniq_idem (user_id, idem_key),
  INDEX idx_show_user_status (show_id, user_id, status),
  CONSTRAINT fk_res_show FOREIGN KEY (show_id) REFERENCES shows(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reservation_seats (
  reservation_id VARCHAR(32) NOT NULL,
  show_id VARCHAR(32) NOT NULL,
  seat_id VARCHAR(16) NOT NULL,
  cancelled_at TIMESTAMP(3) NULL,
  active_key VARCHAR(64) GENERATED ALWAYS AS
    (CASE WHEN cancelled_at IS NULL THEN CONCAT(show_id,':',seat_id) ELSE NULL END) VIRTUAL,
  PRIMARY KEY (reservation_id, seat_id),
  UNIQUE KEY uniq_active_seat (active_key),
  CONSTRAINT fk_rs_res FOREIGN KEY (reservation_id) REFERENCES reservations(id)
) ENGINE=InnoDB;
