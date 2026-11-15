type: internal
area: tests

- The support-assets test for unwritable managed roots is skipped when tests run as root (containers, CI images), where `chmod 555` does not stop writes, so `bun run test:fast` no longer fails there.
