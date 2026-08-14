// Tests need valid boot values but must never depend on a developer or production .env.
// Existing explicit values always win so integration environments can supply their own.
process.env.MASTER_KEY ||= "bonni-core-test-master-key-2026";
process.env.DATABASE_URL ||= "postgresql://bonni_test:bonni_test@127.0.0.1:5432/bonni_test";
process.env.NODE_ENV ||= "test";
