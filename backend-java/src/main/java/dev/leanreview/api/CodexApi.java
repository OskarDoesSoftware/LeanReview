package dev.leanreview.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.leanreview.codex.CodexProvider;
import java.util.Map;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/codex")
public class CodexApi {
  private final ObjectMapper json;
  private final CodexProvider codex;

  public CodexApi(ObjectMapper json, CodexProvider codex) {
    this.json = json;
    this.codex = codex;
  }

  private ResponseEntity<String> reply(Object value) throws Exception {
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .body(json.writeValueAsString(value));
  }

  @GetMapping("/status")
  public ResponseEntity<String> status() throws Exception {
    return reply(codex.status());
  }

  @PostMapping("/login")
  public ResponseEntity<String> login() throws Exception {
    return reply(codex.login());
  }

  @PostMapping("/cancel-login")
  public ResponseEntity<String> cancel() throws Exception {
    codex.cancelLogin();
    return reply(Map.of("ok", true));
  }

  @PostMapping("/logout")
  public ResponseEntity<String> logout() throws Exception {
    codex.logout();
    return reply(Map.of("ok", true));
  }
}
