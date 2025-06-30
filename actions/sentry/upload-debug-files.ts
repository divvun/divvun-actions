import { exec } from "~/builder.ts"
import logger from "../../util/log.ts"

export type SentryUploadIOSDebugFilesOptions = {
  authToken: string;
  projectId: string;
  dsymSearchPath: string;
};

export async function sentryUploadIOSDebugFiles(options: SentryUploadIOSDebugFilesOptions) {
  try {
    await exec(
      "sentry-cli",
      [
        "debug-files",
        "upload",
        "--auth-token",
        options.authToken,
        "--org",
        "divvun",
        "--project",
        options.projectId,
        options.dsymSearchPath,
      ]
    );
  } catch (error) {
    logger.error("Failed to upload dSYM files to Sentry:", error);
  }
}
