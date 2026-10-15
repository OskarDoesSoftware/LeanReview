package dev.leanreview.api;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class LocalAccessTest {
  private static final String ORIGIN = "http://127.0.0.1:4318";
  private final ObjectMapper json = new ObjectMapper();

  private LocalAccess access() {
    return new LocalAccess(ORIGIN, json, Clock.systemUTC(), "fixture-startup-nonce");
  }

  private MockHttpServletRequest request(String method, String path, String host, String origin) {
    var request = new MockHttpServletRequest(method, path);
    if (host != null) request.addHeader("Host", host);
    if (origin != null) request.addHeader("Origin", origin);
    return request;
  }

  private MockHttpServletResponse call(LocalAccess access, MockHttpServletRequest request)
      throws Exception {
    var response = new MockHttpServletResponse();
    access.doFilter(
        request, response, (incoming, outgoing) -> outgoing.getWriter().write("allowed"));
    return response;
  }

  private MockHttpServletRequest bootstrap() {
    var request = request("POST", "/api/session", "127.0.0.1:4318", ORIGIN);
    request.setContentType("application/json");
    request.setContent(
        "{\"nonce\":\"fixture-startup-nonce\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    return request;
  }

  @Test
  void coverageImportHasASeparateAuthenticatedBoundWithoutWideningOtherRoutes() throws Exception {
    var access = access();
    String cookie = call(access, bootstrap()).getHeader("Set-Cookie").split(";")[0];
    var imported =
        request("POST", "/api/sessions/fixture/coverage/import", "127.0.0.1:4318", ORIGIN);
    imported.setContentType("application/vnd.leanreview.coverage+json");
    imported.setContent(new byte[2 * 1024 * 1024]);
    assertThat(call(access, imported).getStatus()).isEqualTo(401);
    imported.addHeader("Cookie", cookie);
    assertThat(call(access, imported).getContentAsString()).isEqualTo("allowed");
    imported.setContent(new byte[20 * 1024 * 1024 + 1]);
    assertThat(call(access, imported).getStatus()).isEqualTo(413);
    imported.setContent(new byte[2 * 1024 * 1024]);
    imported.setContentType("application/json");
    assertThat(call(access, imported).getStatus()).isEqualTo(413);
    var other = request("POST", "/api/sessions", "127.0.0.1:4318", ORIGIN);
    other.addHeader("Cookie", cookie);
    other.setContentType("application/vnd.leanreview.coverage+json");
    other.setContent(new byte[2 * 1024 * 1024]);
    assertThat(call(access, other).getStatus()).isEqualTo(413);
  }

  @Test
  void sessionIsSingleUseAndOnlyValidForItsLaunch() throws Exception {
    var access = access();
    var response = call(access, bootstrap());
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
    assertThat(response.getHeader("Set-Cookie"))
        .contains("HttpOnly", "SameSite=Strict", "Max-Age=43200");
    String cookie = response.getHeader("Set-Cookie").split(";")[0];
    var authenticated = request("GET", "/api/sessions", "127.0.0.1:4318", null);
    authenticated.addHeader("Cookie", cookie);
    assertThat(call(access, authenticated).getContentAsString()).isEqualTo("allowed");
    assertThat(call(access, bootstrap()).getStatus()).isEqualTo(403);
    assertThat(call(access(), authenticated).getStatus()).isEqualTo(401);
  }

  @Test
  void requiresLocalHostAndOriginBeforeAcceptingTheNonce() throws Exception {
    var access = access();
    var foreign = bootstrap();
    foreign.removeHeader("Host");
    foreign.addHeader("Host", "evil.example");
    assertThat(call(access, foreign).getContentAsString()).contains("Invalid local host.");
    var cross = bootstrap();
    cross.removeHeader("Origin");
    cross.addHeader("Origin", "https://evil.example");
    assertThat(call(access, cross).getContentAsString()).contains("Cross-origin request rejected.");
    var noOrigin = bootstrap();
    noOrigin.removeHeader("Origin");
    assertThat(call(access, noOrigin).getContentAsString())
        .contains("Same-origin request required.");
    assertThat(call(access, bootstrap()).getStatus()).isEqualTo(200);
  }

  @Test
  void protectsDecodedApiPathsWithMatrixParameters() throws Exception {
    var request = request("GET", "/api;parameter/sessions", "127.0.0.1:4318", null);
    request.setServletPath("/api;parameter/sessions");
    assertThat(call(access(), request).getStatus()).isEqualTo(401);
    var encoded = request("GET", "/%61pi/sessions", "127.0.0.1:4318", null);
    encoded.setServletPath("/api/sessions");
    assertThat(call(access(), encoded).getStatus()).isEqualTo(401);
  }

  @Test
  void rejectsExpiredAndInvalidBootstrapInput() throws Exception {
    Clock old = Clock.fixed(Instant.EPOCH, ZoneOffset.UTC);
    var access = new LocalAccess(ORIGIN, json, old, "fixture-startup-nonce");
    var invalid = bootstrap();
    invalid.setContent("null".getBytes());
    assertThat(call(access, invalid).getStatus()).isEqualTo(400);
    var oversized = bootstrap();
    oversized.setContent(new byte[1024 * 1024 + 1]);
    assertThat(call(access, oversized).getStatus()).isEqualTo(413);
    assertThat(call(access, bootstrap()).getStatus()).isEqualTo(200);
    // A clock that advances after construction exercises expiry without sleeping.
    var calls = new java.util.concurrent.atomic.AtomicInteger();
    Clock advancing =
        new Clock() {
          public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
          }

          public Clock withZone(java.time.ZoneId zone) {
            return this;
          }

          public Instant instant() {
            return Instant.ofEpochMilli(calls.getAndIncrement() == 0 ? 0 : 300001);
          }
        };
    var expired = new LocalAccess(ORIGIN, json, advancing, "fixture-startup-nonce");
    assertThat(call(expired, bootstrap()).getContentAsString()).contains("Startup link expired");
  }
}
