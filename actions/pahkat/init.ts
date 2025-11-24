import { PahkatPrefix } from "~/util/shared.ts"

export type Props = {
  repoUrl: string
  channel: string | null
  packages: string[]
}

export default async function pahkatInit({
  repoUrl,
  channel,
  packages,
}: Props) {
  await PahkatPrefix.bootstrap([])
  await PahkatPrefix.addRepo(repoUrl, channel ?? undefined)
  await PahkatPrefix.install(packages)
}
