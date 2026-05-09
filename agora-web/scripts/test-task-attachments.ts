import assert from "node:assert/strict";

import {
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  SUPPORTED_FILE_ACCEPT,
  SUPPORTED_FILE_TOOLTIP,
  resolveAttachmentSelection,
} from "../src/lib/taskAttachments";

const imagePng = new File(["img"], "diagram.png", { type: "image/png" });
const codePy = new File(["print('x')"], "worker.py", { type: "text/x-python" });
const oversizedPdf = new File(["x".repeat(16)], "report.pdf", { type: "application/pdf" });
Object.defineProperty(oversizedPdf, "size", { value: MAX_FILE_BYTES + 1 });

assert.equal(MAX_ATTACHMENTS, 3);
assert.ok(SUPPORTED_FILE_ACCEPT.includes(".pdf"));
assert.ok(SUPPORTED_FILE_ACCEPT.includes(".xlsx"));
assert.ok(SUPPORTED_FILE_ACCEPT.includes(".parquet"));
assert.ok(SUPPORTED_FILE_TOOLTIP.includes("5 MB"));
assert.ok(SUPPORTED_FILE_TOOLTIP.includes("XLSX"));
assert.ok(!SUPPORTED_FILE_TOOLTIP.includes("DOCX"));

const accepted = resolveAttachmentSelection({
  existingUrlCount: 1,
  existingFileCount: 0,
  files: [imagePng, codePy],
});
assert.equal(accepted.acceptedFiles.length, 2);
assert.equal(accepted.errors.length, 0);

const rejectedForCount = resolveAttachmentSelection({
  existingUrlCount: 2,
  existingFileCount: 1,
  files: [imagePng],
});
assert.equal(rejectedForCount.acceptedFiles.length, 0);
assert.ok(rejectedForCount.errors.some((message) => message.includes("up to 3")));

const rejectedForSize = resolveAttachmentSelection({
  existingUrlCount: 0,
  existingFileCount: 0,
  files: [oversizedPdf],
});
assert.equal(rejectedForSize.acceptedFiles.length, 0);
assert.ok(rejectedForSize.errors.some((message) => message.includes("5 MB")));

console.log("task-attachments-ok");
