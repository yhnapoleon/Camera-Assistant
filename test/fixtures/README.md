The `https-*.pem` files are disposable test-only TLS fixtures for localhost and
127.0.0.1. Their private key is intentionally public and must never be used by a
running user service. Production phone certificates live in ignored `certs/`
and use a different CA and key. The fixture certificate expires in January 2029.
