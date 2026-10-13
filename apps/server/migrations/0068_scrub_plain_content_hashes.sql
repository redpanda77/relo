-- E1.3: bodies are now digested with a server-keyed HMAC. Hashes written before were plain SHA-256,
-- which let anyone with a database dump confirm a guessed body. Nothing reads them, so replace each
-- with a random value of the same shape.
UPDATE notification_contents
SET content_sha256=encode(sha256(convert_to(gen_random_uuid()::text||clock_timestamp()::text,'UTF8')),'hex');
