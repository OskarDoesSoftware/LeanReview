package dev.leanreview.llm;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;

class ProviderClientTest {
  private final ObjectMapper json = new ObjectMapper();
  private final JsonNode result =
      json.readTree(
          "{\"cohorts\":[{\"name\":\"Changes\",\"explanation\":\"\",\"layers\":[{\"name\":\"Read\",\"explanation\":\"\",\"fileIds\":[\"file\"]}]}],\"findings\":[]}");

  ProviderClientTest() throws Exception {}

  @Test
  void rejectsTruncatedIncompleteAndRefusedProviderOutput() throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          exchange.getRequestBody().readAllBytes();
          byte[] body =
              "{\"done_reason\":\"length\",\"status\":\"incomplete\",\"stop_reason\":\"max_tokens\"}"
                  .getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, body.length);
          exchange.getResponseBody().write(body);
          exchange.close();
        });
    server.start();
    try (var client = new ProviderClient(json)) {
      var cases =
          java.util.Map.of(
              "ollama",
              "Provider output was truncated.",
              "openai",
              "Provider did not complete the response.",
              "anthropic",
              "Provider output was refused or incomplete.");
      for (var example : cases.entrySet())
        assertThatThrownBy(
                () ->
                    client.infer(
                        config(example.getKey(), server.getAddress().getPort()),
                        "fixture-key",
                        json.createObjectNode(),
                        new Cancellation()))
            .hasMessage(example.getValue());
    } finally {
      server.stop(0);
    }
  }

  private ObjectNode config(String provider, int port) {
    return json.createObjectNode()
        .put("provider", provider)
        .put("endpoint", "http://127.0.0.1:" + port)
        .put("model", "fixture")
        .put("contextWindow", 8192)
        .put("maxOutput", 2048)
        .put("localOnly", provider.equals("ollama"));
  }

  @Test
  void sendsBoundedStructuredRequestsToAllThreeAdapters() throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    AtomicReference<JsonNode> request = new AtomicReference<>();
    AtomicReference<String> authorization = new AtomicReference<>(),
        apiKey = new AtomicReference<>();
    server.createContext(
        "/",
        exchange -> {
          request.set(json.readTree(exchange.getRequestBody()));
          authorization.set(exchange.getRequestHeaders().getFirst("authorization"));
          apiKey.set(exchange.getRequestHeaders().getFirst("x-api-key"));
          ObjectNode reply = json.createObjectNode();
          switch (exchange.getRequestURI().getPath()) {
            case "/api/chat" -> reply.putObject("message").put("content", result.toString());
            case "/responses" -> {
              reply.put("status", "completed");
              reply
                  .putArray("output")
                  .addObject()
                  .putArray("content")
                  .addObject()
                  .put("type", "output_text")
                  .put("text", result.toString());
            }
            case "/messages" -> {
              reply.put("stop_reason", "end_turn");
              reply
                  .putArray("content")
                  .addObject()
                  .put("type", "text")
                  .put("text", result.toString());
            }
            default -> throw new AssertionError("Unexpected provider path");
          }
          byte[] body = json.writeValueAsBytes(reply);
          exchange.sendResponseHeaders(200, body.length);
          exchange.getResponseBody().write(body);
          exchange.close();
        });
    server.start();
    try (var client = new ProviderClient(json)) {
      ObjectNode input = json.createObjectNode();
      input.putArray("files").addObject().put("id", "file").put("diff", "untrusted input");
      for (String provider : new String[] {"ollama", "openai", "anthropic"}) {
        assertThat(
                client.infer(
                    config(provider, server.getAddress().getPort()),
                    "fixture-key",
                    input,
                    new Cancellation()))
            .isEqualTo(result);
        JsonNode sent = request.get();
        assertThat(sent.path("model").asText()).isEqualTo("fixture");
        switch (provider) {
          case "ollama" -> {
            assertThat(sent.path("messages").get(0).path("content").asText())
                .isEqualTo(ProviderClient.INSTRUCTIONS);
            assertThat(sent.path("messages").get(1).path("content").asText())
                .isEqualTo(input.toString());
            assertThat(sent.path("format").path("type").asText()).isEqualTo("object");
          }
          case "openai" -> {
            assertThat(authorization.get()).isEqualTo("Bearer fixture-key");
            assertThat(sent.path("store").asBoolean(true)).isFalse();
            assertThat(sent.path("text").path("format").path("strict").asBoolean()).isTrue();
          }
          case "anthropic" -> {
            assertThat(apiKey.get()).isEqualTo("fixture-key");
            assertThat(sent.path("max_tokens").asInt()).isEqualTo(2048);
          }
        }
      }
    } finally {
      server.stop(0);
    }
  }

  @Test
  void rejectsRedirectsMalformedAndOversizedResponsesWithoutEchoingBodies() throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    AtomicInteger mode = new AtomicInteger(), leaked = new AtomicInteger();
    server.createContext(
        "/api/chat",
        exchange -> {
          exchange.getRequestBody().readAllBytes();
          if (mode.get() == 0) {
            exchange.getResponseHeaders().set("Location", "/leak");
            exchange.sendResponseHeaders(302, -1);
          } else {
            byte[] body =
                (mode.get() == 1
                        ? "private-provider-secret: invalid JSON"
                        : "x".repeat(8 * 1024 * 1024 + 1))
                    .getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try {
              exchange.getResponseBody().write(body);
            } catch (java.io.IOException canceled) {
            }
          }
          exchange.close();
        });
    server.createContext(
        "/leak",
        exchange -> {
          leaked.incrementAndGet();
          exchange.sendResponseHeaders(200, -1);
          exchange.close();
        });
    server.start();
    try (var client = new ProviderClient(json)) {
      for (int i = 0; i < 3; i++) {
        mode.set(i);
        assertThatThrownBy(
                () ->
                    client.infer(
                        config("ollama", server.getAddress().getPort()),
                        null,
                        json.createObjectNode(),
                        new Cancellation()))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageNotContaining("private-provider-secret");
      }
      assertThat(leaked.get()).isZero();
    } finally {
      server.stop(0);
    }
  }

  @Test
  void cancellationInterruptsAnInflightHttpRequest() throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    server.createContext(
        "/api/chat",
        exchange -> {
          exchange.getRequestBody().readAllBytes();
          entered.countDown();
          try {
            release.await(10, TimeUnit.SECONDS);
            exchange.sendResponseHeaders(200, -1);
          } catch (Exception closed) {
          } finally {
            exchange.close();
          }
        });
    server.start();
    try (var client = new ProviderClient(json);
        var workers = Executors.newVirtualThreadPerTaskExecutor()) {
      var cancellation = new Cancellation();
      var pending =
          workers.submit(
              () ->
                  client.infer(
                      config("ollama", server.getAddress().getPort()),
                      null,
                      json.createObjectNode(),
                      cancellation));
      assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      cancellation.cancel();
      assertThatThrownBy(() -> pending.get(2, TimeUnit.SECONDS))
          .isInstanceOf(ExecutionException.class)
          .hasCauseInstanceOf(IllegalArgumentException.class);
      release.countDown();
    } finally {
      release.countDown();
      server.stop(0);
    }
  }
}
