import { z } from "zod";

export const editorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  executable: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(2000)).max(32),
});
export type EditorConfig = z.infer<typeof editorSchema>;
