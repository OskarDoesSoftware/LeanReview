package dev.leanreview.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** One launch owns one browser session and one expiring startup link. */
@Component
public class LocalAccess extends OncePerRequestFilter {
  private final String origin;
  private final Set<String> hosts;
  private final String nonce;
  private final String session = secret();
  private final Clock clock;
  private final long expires;
  private final AtomicBoolean consumed = new AtomicBoolean();
  private final ObjectMapper json;

  @org.springframework.beans.factory.annotation.Autowired
  public LocalAccess(
      @Value("${leanreview.origin:http://127.0.0.1:4318}") String origin, ObjectMapper json) {
    this(origin, json, Clock.systemUTC(), secret());
  }

  LocalAccess(String origin, ObjectMapper json, Clock clock, String nonce) {
    URI uri = URI.create(origin);
    if (!"http".equals(uri.getScheme())
        || !Set.of("localhost", "127.0.0.1").contains(uri.getHost())
        || uri.getRawUserInfo() != null
        || uri.getRawQuery() != null
        || uri.getRawFragment() != null
        || (uri.getRawPath() != null && !uri.getRawPath().isEmpty())) {
      throw new IllegalArgumentException("LeanReview requires a loopback HTTP origin.");
    }
    this.origin = origin;
    this.hosts = new java.util.HashSet<>(Set.of("127.0.0.1:4318", "localhost:4318"));
    hosts.add(uri.getRawAuthority());
    this.json = json;
    this.clock = clock;
    this.nonce = nonce;
    expires = clock.millis() + 5 * 60 * 1000;
  }

  private static String secret() {
    byte[] bytes = new byte[32];
    new SecureRandom().nextBytes(bytes);
    return HexFormat.of().formatHex(bytes);
  }

  private static boolean equal(String left, String right) {
    return right != null
        && MessageDigest.isEqual(
            left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8));
  }

  // Used by the launcher only. Never expose this value in an API response or ordinary logs.
  public String startupLink() {
    return origin + "/#bootstrap=" + nonce;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    // Match the decoded servlet path Spring routes, including matrix parameters.
    String path = request.getServletPath();
    if (path == null || path.isEmpty()) path = request.getRequestURI();
    path = path.replaceAll(";[^/]*", "").replaceAll("/+", "/");
    return !path.equals("/api") && !path.startsWith("/api/");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws IOException, ServletException {
    response.setHeader("Cache-Control", "no-store");
    if (!hosts.contains(request.getHeader("Host"))) {
      reject(response, 403, "Invalid local host.");
      return;
    }
    String incoming = request.getHeader("Origin");
    if (incoming != null && !incoming.isEmpty() && !incoming.equals(origin)) {
      reject(response, 403, "Cross-origin request rejected.");
      return;
    }
    if (!Set.of("GET", "HEAD").contains(request.getMethod()) && !origin.equals(incoming)) {
      reject(response, 403, "Same-origin request required.");
      return;
    }
    if (request.getRequestURI().equals("/api/session") && request.getMethod().equals("POST")) {
      byte[] body = request.getInputStream().readNBytes(1024 * 1024 + 1);
      if (body.length > 1024 * 1024) {
        reject(response, 413, "Request body is too large.");
        return;
      }
      String candidate;
      try {
        var parsed = json.readTree(body);
        if (parsed == null || !parsed.path("nonce").isTextual()) {
          reject(response, 400, "Invalid request.");
          return;
        }
        candidate = parsed.path("nonce").asText();
      } catch (IOException invalid) {
        reject(response, 400, "Invalid request.");
        return;
      }
      if (clock.millis() > expires
          || !equal(nonce, candidate)
          || !consumed.compareAndSet(false, true)) {
        reject(
            response,
            403,
            "Startup link expired or already used. Restart LeanReview for a new link.");
        return;
      }
      response.addHeader(
          "Set-Cookie",
          "leanreview=" + session + "; Max-Age=43200; Path=/; HttpOnly; SameSite=Strict");
      response.setContentType("application/json; charset=utf-8");
      json.writeValue(response.getOutputStream(), Map.of("ok", true));
      return;
    }
    String candidate = "";
    String cookies = request.getHeader("Cookie");
    if (cookies != null)
      for (String cookie : cookies.split(";")) {
        if (cookie.trim().startsWith("leanreview=")) {
          candidate = cookie.trim().substring("leanreview=".length());
          break;
        }
      }
    if (!equal(session, candidate)) {
      reject(response, 401, "Open LeanReview using its startup link to establish a local session.");
      return;
    }
    if (!Set.of("GET", "HEAD").contains(request.getMethod())) {
      byte[] body = request.getInputStream().readNBytes(1024 * 1024 + 1);
      if (body.length > 1024 * 1024) {
        reject(response, 413, "Request body is too large.");
        return;
      }
      var replay =
          new HttpServletRequestWrapper(request) {
            @Override
            public ServletInputStream getInputStream() {
              var input = new ByteArrayInputStream(body);
              return new ServletInputStream() {
                public int read() {
                  return input.read();
                }

                public int read(byte[] bytes, int offset, int length) {
                  return input.read(bytes, offset, length);
                }

                public boolean isFinished() {
                  return input.available() == 0;
                }

                public boolean isReady() {
                  return true;
                }

                public void setReadListener(ReadListener listener) {
                  throw new UnsupportedOperationException("Synchronous request body.");
                }
              };
            }

            @Override
            public java.io.BufferedReader getReader() {
              return new java.io.BufferedReader(
                  new java.io.InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
            }
          };
      chain.doFilter(replay, response);
    } else chain.doFilter(request, response);
  }

  private void reject(HttpServletResponse response, int status, String message) throws IOException {
    response.setStatus(status);
    response.setContentType("application/json; charset=utf-8");
    json.writeValue(response.getOutputStream(), Map.of("error", message));
  }
}
