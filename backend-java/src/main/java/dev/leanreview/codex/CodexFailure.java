package dev.leanreview.codex;

/** Only adapter-owned messages may be persisted or returned; never raw CLI diagnostics. */
public final class CodexFailure extends java.io.IOException {
  CodexFailure(String message) {
    super(message);
  }
}
