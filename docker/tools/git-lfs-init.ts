import type { Tool } from "../lib/image.ts"

/** `git lfs install` — enable the git-lfs smudge/clean filters for root. */
export function gitLfsInit(): Tool {
  return {
    name: "git-lfs init",
    render: () => `RUN git lfs install`,
  }
}
