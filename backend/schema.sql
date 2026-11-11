-- ============================================================
--  RTNote - Esquema PostgreSQL
--  Idempotente: puede ejecutarse varias veces sin romper datos.
--  Uso:  psql -h <host> -U <usuario> -d <base> -f schema.sql
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
--  Tabla: users
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                SERIAL PRIMARY KEY,
    username          VARCHAR(32)  NOT NULL,
    password_hash     VARCHAR(255) NOT NULL,
    -- BIGINT: los chat_id de Telegram pueden superar el rango de INTEGER
    -- y ser negativos (grupos/canales).
    telegram_chat_id  BIGINT       NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT users_username_format_chk
        CHECK (username ~ '^[A-Za-z0-9_.-]{3,32}$')
);

-- Username único sin distinguir mayúsculas/minúsculas
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx
    ON users (LOWER(username));

-- ------------------------------------------------------------
--  Tabla: reminders
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reminders (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         VARCHAR(150) NOT NULL,
    description   TEXT         NULL,
    -- TIMESTAMPTZ: se almacena en UTC; el cliente envía ISO-8601 con zona.
    scheduled_at  TIMESTAMPTZ  NOT NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'pending',
    -- Campos de soporte para el motor de notificaciones (Etapa 2)
    attempts      SMALLINT     NOT NULL DEFAULT 0,
    last_error    TEXT         NULL,
    sent_at       TIMESTAMPTZ  NULL,
    notify_30m_before BOOLEAN  NOT NULL DEFAULT FALSE,
    notify_15m_before BOOLEAN  NOT NULL DEFAULT FALSE,
    sent_30m_at   TIMESTAMPTZ  NULL,
    sent_15m_at   TIMESTAMPTZ  NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT reminders_status_chk
        CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
    CONSTRAINT reminders_title_not_blank_chk
        CHECK (LENGTH(TRIM(title)) > 0)
);

-- ------------------------------------------------------------
--  Migración Etapa 2 (idempotente)
--  locked_until cumple dos funciones para el scheduler:
--    1) "Lease": mientras un worker procesa el recordatorio, nadie más lo toma.
--    2) Backoff: tras un fallo reintentable, no se reintenta antes de esa hora.
--  Si el proceso muere a mitad de un envío, el lease expira y otro tick lo retoma.
-- ------------------------------------------------------------
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ NULL;

-- ------------------------------------------------------------
--  Migración v1.1: Pre-Avisos (30m y 15m antes)
-- ------------------------------------------------------------
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS notify_30m_before BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS notify_15m_before BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS sent_30m_at TIMESTAMPTZ NULL;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS sent_15m_at TIMESTAMPTZ NULL;

-- Índice parcial: el scheduler solo busca recordatorios pendientes
-- cuya fecha ya venció -> índice pequeño y muy rápido.
CREATE INDEX IF NOT EXISTS reminders_pending_scheduled_idx
    ON reminders (scheduled_at)
    WHERE status = 'pending';

-- Índices parciales para optimizar búsquedas de recordatorios pendientes con pre-avisos
CREATE INDEX IF NOT EXISTS reminders_pending_30m_idx
    ON reminders (scheduled_at)
    WHERE status = 'pending' AND notify_30m_before = TRUE AND sent_30m_at IS NULL;

CREATE INDEX IF NOT EXISTS reminders_pending_15m_idx
    ON reminders (scheduled_at)
    WHERE status = 'pending' AND notify_15m_before = TRUE AND sent_15m_at IS NULL;

-- Listado de recordatorios por usuario ordenados por fecha
CREATE INDEX IF NOT EXISTS reminders_user_scheduled_idx
    ON reminders (user_id, scheduled_at DESC);

-- ------------------------------------------------------------
--  Trigger genérico para mantener updated_at
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS reminders_set_updated_at ON reminders;
CREATE TRIGGER reminders_set_updated_at
    BEFORE UPDATE ON reminders
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
