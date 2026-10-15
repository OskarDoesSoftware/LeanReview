package dev.leanreview.api;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import jakarta.servlet.http.HttpServletRequest;
import java.io.*;
import java.util.*;

/**
 * Bounded JSON input and Zod-compatible primitive diagnostics for the existing core wire contract.
 */
public final class WireInput {
  private static final ObjectMapper JSON =
      new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

  private WireInput() {}

  public static JsonNode body(HttpServletRequest request) throws IOException {
    byte[] bytes = request.getInputStream().readNBytes(1024 * 1024 + 1);
    if (bytes.length > 1024 * 1024) throw new IllegalArgumentException("request entity too large");
    if (bytes.length == 0) return MissingNode.getInstance();
    try {
      return JSON.readTree(bytes);
    } catch (IOException e) {
      throw new IllegalArgumentException("Invalid JSON request.");
    }
  }

  public static String text(JsonNode body, String field) {
    return text(body, field, 0, Integer.MAX_VALUE, false);
  }

  public static String text(JsonNode body, String field, int minimum, int maximum, boolean trim) {
    JsonNode value = body.path(field);
    if (!value.isTextual()) throw invalid("string", value, field);
    String text = trim ? value.asText().strip() : value.asText();
    if (text.length() < minimum || text.length() > maximum)
      throw new IllegalArgumentException("Invalid " + field + " length.");
    return text;
  }

  public static void object(JsonNode value) {
    if (!value.isObject()) throw invalid("object", value);
  }

  public static int positive(JsonNode body, String key, int defaultValue) {
    JsonNode value = body.path(key);
    if (value.isMissingNode() && defaultValue > 0) return defaultValue;
    if (!value.isIntegralNumber() || !value.canConvertToInt() || value.asInt() < 1)
      throw new IllegalArgumentException("Invalid " + key + ".");
    return value.asInt();
  }

  public static String choice(JsonNode body, String key, String... choices) {
    String value = text(body, key);
    if (!List.of(choices).contains(value))
      throw new IllegalArgumentException("Invalid " + key + ".");
    return value;
  }

  public static ArrayNode strings(JsonNode body, String key) {
    JsonNode value = body.path(key);
    if (!value.isArray()) throw invalid("array", value, key);
    for (JsonNode item : value)
      if (!item.isTextual()) throw new IllegalArgumentException("Invalid " + key + ".");
    return (ArrayNode) value;
  }

  public static IllegalArgumentException invalid(String expected, JsonNode value, String... path) {
    ObjectNode error = typeError(expected, value, path);
    return errors(JSON.createArrayNode().add(error));
  }

  public static ObjectNode typeError(String expected, JsonNode value, String... path) {
    String received =
        value.isMissingNode()
            ? "undefined"
            : value.isNull()
                ? "null"
                : value.isArray()
                    ? "array"
                    : value.isTextual()
                        ? "string"
                        : value.isBoolean() ? "boolean" : value.isNumber() ? "number" : "object";
    ObjectNode result =
        JSON.createObjectNode().put("expected", expected).put("code", "invalid_type");
    ArrayNode where = result.putArray("path");
    for (String part : path) where.add(part);
    return result.put("message", "Invalid input: expected " + expected + ", received " + received);
  }

  public static IllegalArgumentException errors(ArrayNode errors) {
    try { // Jackson's default pretty printer differs from JSON.stringify for arrays.
      return new IllegalArgumentException(pretty(errors, 0));
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }

  private static String pretty(JsonNode node, int depth) throws IOException {
    if (!node.isContainerNode()) return JSON.writeValueAsString(node);
    if (node.isEmpty()) return node.isArray() ? "[]" : "{}";
    String indent = "  ".repeat(depth), child = indent + "  ";
    var lines = new ArrayList<String>();
    if (node.isArray()) for (JsonNode item : node) lines.add(child + pretty(item, depth + 1));
    else {
      var fields = node.fields();
      while (fields.hasNext()) {
        var field = fields.next();
        lines.add(
            child
                + JSON.writeValueAsString(field.getKey())
                + ": "
                + pretty(field.getValue(), depth + 1));
      }
    }
    return (node.isArray() ? "[\n" : "{\n")
        + String.join(",\n", lines)
        + "\n"
        + indent
        + (node.isArray() ? "]" : "}");
  }

  public static ObjectNode comparison(JsonNode value) {
    object(value);
    String mode = choice(value, "mode", "all", "staged", "unstaged", "branch");
    String base = value.has("base") ? text(value, "base", 1, 200, false) : "main";
    return JSON.createObjectNode().put("mode", mode).put("base", base);
  }
}
