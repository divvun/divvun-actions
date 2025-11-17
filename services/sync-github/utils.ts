export function parseNextLinkHeader(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null
  }

  const linksArray = linkHeader.split(",").map((link) => {
    let [url, rel] = link.split(";").map((part) => part.trim())
    url = url.slice(1, -1)
    rel = rel.split("=")[1].slice(1, -1)
    return { url, rel }
  })

  const nextLink = linksArray.find((link) => link.rel === "next")
  if (!nextLink) {
    return null
  }

  return nextLink.url
}

export function requiredArgs(
  required: string[],
  args: Record<string, unknown>,
): void {
  for (const arg of required) {
    if (!args[arg]) {
      console.error(`Missing required argument: ${arg}`)
      Deno.exit(1)
    }
  }
}
