package dev.leanreview.api;

import java.io.IOException;
import java.nio.file.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.config.annotation.*;

@Configuration
@RestController
public class Frontend implements WebMvcConfigurer {
  private final Path directory;

  public Frontend(@Value("${leanreview.frontend-directory:../frontend/dist}") String directory) {
    this.directory = Path.of(directory).toAbsolutePath().normalize();
  }

  @Override
  public void addResourceHandlers(ResourceHandlerRegistry registry) {
    registry
        .addResourceHandler("/assets/**")
        .addResourceLocations(directory.resolve("assets").toUri().toString());
  }

  @GetMapping("/")
  public ResponseEntity<String> index() throws IOException {
    Path index = directory.resolve("index.html");
    return Files.exists(index)
        ? ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(Files.readString(index))
        : ResponseEntity.status(404).body("Build the React frontend first.");
  }
}
