export const MAX_ATTACHMENTS = 3;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_FILE_EXTENSIONS = [
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".txt",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".xlsx",
  ".xls",
  ".xlsb",
  ".parquet",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
] as const;
export const SUPPORTED_FILE_ACCEPT = SUPPORTED_FILE_EXTENSIONS.join(",");
export const SUPPORTED_FILE_TOOLTIP =
  "Supported file types: PY, TS, TSX, JS, JSX, JSON, MD, TXT, CSV, TSV, YAML, YML, XLSX, XLS, XLSB, PARQUET, PDF, PNG, JPG, JPEG, WEBP, GIF. Max 5 MB each. Up to 3 total attachments.";

export interface PendingAttachmentFile {
  id: string;
  file: File;
}

export interface AttachmentSelectionResult {
  acceptedFiles: PendingAttachmentFile[];
  errors: string[];
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function humanMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildPendingId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function resolveAttachmentSelection(input: {
  existingUrlCount: number;
  existingFileCount: number;
  files: File[];
}): AttachmentSelectionResult {
  const acceptedFiles: PendingAttachmentFile[] = [];
  const errors: string[] = [];
  const remainingSlots = Math.max(0, MAX_ATTACHMENTS - input.existingUrlCount - input.existingFileCount);

  if (input.files.length > remainingSlots) {
    errors.push(`Attach up to ${MAX_ATTACHMENTS} total URLs/files per task.`);
  }

  for (const file of input.files.slice(0, remainingSlots)) {
    const extension = fileExtension(file.name);
    if (!SUPPORTED_FILE_EXTENSIONS.includes(extension as (typeof SUPPORTED_FILE_EXTENSIONS)[number])) {
      errors.push(`Unsupported file type for ${file.name}.`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name} exceeds the 5 MB limit (${humanMegabytes(file.size)}).`);
      continue;
    }
    acceptedFiles.push({ id: buildPendingId(file), file });
  }

  return { acceptedFiles, errors };
}

export function attachmentCountLabel(input: {
  urls: string[];
  files: Array<PendingAttachmentFile | { source_id: string }>;
}): string | null {
  const total = input.urls.length + input.files.length;
  return total > 0 ? String(total) : null;
}
