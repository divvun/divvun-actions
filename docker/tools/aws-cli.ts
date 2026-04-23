import type { Tool } from "../lib/image.ts"

/** Install the official AWS CLI v2 bundle. */
export function awsCli(): Tool {
  return {
    name: "aws-cli v2",
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return `RUN msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi /qn`
      }
      return [
        `RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \\`,
        `    unzip awscliv2.zip && \\`,
        `    ./aws/install && \\`,
        `    rm awscliv2.zip`,
      ].join("\n")
    },
  }
}
