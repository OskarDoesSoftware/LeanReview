import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
type Props = {
  original: string;
  modified: string;
  language: string;
  theme: string;
  height: string;
  options: monaco.editor.IStandaloneDiffEditorConstructionOptions;
  onMount: (editor: monaco.editor.IStandaloneDiffEditor) => void;
};
export function DiffEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => {
    const before = monaco.editor.createModel(props.original, props.language);
    const after = monaco.editor.createModel(props.modified, props.language);
    const editor = monaco.editor.createDiffEditor(host.current!, {
      ...props.options,
      theme: props.theme,
    });
    instance.current = editor;
    editor.setModel({ original: before, modified: after });
    props.onMount(editor);
    return () => {
      // Detach first: disposing attached models raises errors in newer Monaco releases.
      editor.setModel(null);
      editor.dispose();
      before.dispose();
      after.dispose();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    instance.current?.updateOptions(props.options);
    monaco.editor.setTheme(props.theme);
  }, [props.options.renderSideBySide, props.theme]);
  return (
    <div
      ref={host}
      style={{ height: props.height }}
      role="region"
      aria-label="Code diff"
    />
  );
}
