---
name: testing
description: Testing standards and requirements for all produced code.
---

# Testing Rules

1. **Test-Driven**: Write tests before or alongside implementation, never after-the-fact.
2. **Coverage Minimum**: All critical paths must have test coverage. Aim for 80%+.
3. **Isolation**: Tests must not depend on external services unless explicitly designated as integration tests.
4. **Reproducibility**: Tests must be deterministic — no reliance on time, random values, or network state.
5. **Fast Feedback**: Unit tests should complete in < 5 seconds per file.
6. **Naming**: Test names describe the behavior being verified, not the implementation.
7. **CI Gate**: No code moves to production without passing the full test suite.
