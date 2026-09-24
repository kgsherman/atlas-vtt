import { toast } from "sonner"

/** Copy text and confirm with a toast (or show the text when the clipboard is unavailable). */
export async function copyText(text: string, what = "Link"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
    return true
  } catch {
    toast.error("Couldn't copy to the clipboard", { description: text })
    return false
  }
}

/** Save text as a file download. */
export function downloadText(fileName: string, mimeType: string, text: string): void {
  downloadBlob(fileName, new Blob([text], { type: mimeType }))
}

/** Save a blob as a file (the browser's download). */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
