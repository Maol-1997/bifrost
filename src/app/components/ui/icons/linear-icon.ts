import type { ComponentPropsWithoutRef } from "react"

type LinearIconProps = Omit<ComponentPropsWithoutRef<"svg">, "children"> & {
  size?: number | string
  title?: string
}

export type { LinearIconProps }
