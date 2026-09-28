import type { Tool } from "../lib/image.ts"
import {
  IMAGE_BUILT_FILE,
  IMAGE_MANIFEST_DIR,
} from "../../util/image_manifest.ts"

/**
 * Record when the image was built, for `divvun-actions ci` to print.
 *
 * Goes last in `tools`. The RUN text never changes, so Docker reuses this
 * layer exactly when every layer before it was reused: the date is when the
 * image's contents last changed, which is the question a job log needs
 * answered ("is this agent on the new image?").
 */
export function imageStamp(): Tool {
  return {
    name: "image build stamp",
    render: (ctx) => {
      if (ctx.platform === "windows") {
        throw new Error(
          "image stamp: only the linux/alpine images are wired up",
        )
      }
      return `RUN mkdir -p ${IMAGE_MANIFEST_DIR} && date -u +%Y-%m-%dT%H:%M:%SZ > ${IMAGE_BUILT_FILE}`
    },
  }
}
