import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

export function openbao(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.openbao
  return {
    name: `openbao@${version}`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return [
          `RUN Invoke-WebRequest -Uri https://github.com/openbao/openbao/releases/download/v${version}/openbao_${version}_windows_amd64.zip -OutFile bao.zip ; \\`,
          `    Expand-Archive bao.zip -DestinationPath C:\\bin ; \\`,
          `    Remove-Item -Force bao.zip`,
        ].join("\n")
      }
      return [
        `RUN curl -fsSL https://github.com/openbao/openbao/releases/download/v${version}/openbao_${version}_linux_amd64.tar.gz -o bao.tar.gz && \\`,
        `    tar -xzf bao.tar.gz && \\`,
        `    mv bao /usr/local/bin/bao && \\`,
        `    rm bao.tar.gz`,
      ].join("\n")
    },
  }
}
