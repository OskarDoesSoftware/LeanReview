package dev.leanreview.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestControllerAdvice
public class CoreErrors {
  private final ObjectMapper json;

  public CoreErrors(ObjectMapper json) {
    this.json = json;
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<String> error(Exception error) throws IOException {
    // Intentional validation/application messages are public; framework and SQL diagnostics are
    // not.
    String message =
        error instanceof IllegalArgumentException || error instanceof IOException
            ? error.getMessage()
            : "Request failed.";
    if (error instanceof com.fasterxml.jackson.core.JsonProcessingException
        || error instanceof java.nio.file.FileSystemException)
      message = "Captured review data is unavailable.";
    return ResponseEntity.badRequest()
        .contentType(MediaType.parseMediaType("application/json; charset=utf-8"))
        .body(
            json.writeValueAsString(
                Map.of("error", message == null ? "Request failed." : message)));
  }
}
