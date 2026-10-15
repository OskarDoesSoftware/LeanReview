import * as React from "react";
import { Dialog, DialogContent } from "./ui/dialog";

export function ReviewDialog({
  onClose,
  children,
  labelledBy,
}: {
  onClose: () => void;
  children: React.ReactNode;
  labelledBy: string;
}) {
  const previousFocus = React.useRef(document.activeElement);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="modal"
        aria-labelledby={labelledBy}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = previousFocus.current;
          if (target instanceof HTMLElement && target.isConnected)
            target.focus();
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
