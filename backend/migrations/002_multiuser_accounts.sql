BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(16) NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_chk,
  ADD CONSTRAINT users_role_chk CHECK (role IN ('admin', 'user')),
  DROP CONSTRAINT IF EXISTS users_approval_status_chk,
  ADD CONSTRAINT users_approval_status_chk
    CHECK (approval_status IN ('pending', 'approved', 'rejected'));

-- Las cuentas futuras quedan pendientes; las ya existentes se conservan aprobadas.
ALTER TABLE users ALTER COLUMN approval_status SET DEFAULT 'pending';

-- La cuenta histórica del propietario conserva su ID y sus recordatorios.
UPDATE users
   SET role = 'admin', approval_status = 'approved', is_active = TRUE
 WHERE LOWER(username) = LOWER('rony728');

-- Evita dejar el sistema sin administrador por un error de nombre/cuenta.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND is_active = TRUE) THEN
    RAISE EXCEPTION 'No existe una cuenta administradora activa; migración cancelada';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_approval_status_created_idx
  ON users (approval_status, created_at DESC);
CREATE INDEX IF NOT EXISTS users_role_active_idx
  ON users (role, is_active);

COMMIT;
