import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@app/lib/cn"

const inputVariants = cva(
  "w-full appearance-none rounded-lg border-[0.5px] text-[13px] text-linear-bright [line-height:normal] outline-none placeholder:opacity-100 focus:[outline:1px_solid_var(--linear-primary)] focus:[outline-offset:-1px] disabled:cursor-default",
  {
    variants: {
      variant: {
        standard:
          "h-8 border-linear-input-border bg-linear-input px-3 py-1.5 font-normal placeholder:text-linear-input-placeholder transition-[border] duration-150 ease-[ease] hover:border-linear-input-border-hover focus:border-linear-input-border-hover disabled:text-linear-input-disabled disabled:hover:border-linear-input-border data-[preview=hover]:border-linear-input-border-hover",
        compact:
          "h-[26px] border-linear-input-border bg-linear-input px-3 py-1.5 text-xs font-normal placeholder:text-linear-input-placeholder transition-[border] duration-150 ease-[ease] hover:border-linear-input-border-hover focus:border-linear-input-border-hover disabled:text-linear-input-disabled disabled:hover:border-linear-input-border data-[preview=hover]:border-linear-input-border-hover",
        searchSidebar:
          "h-7 border-linear-search-sidebar-border bg-linear-search-sidebar py-1.5 pl-8 pr-[25px] font-medium shadow-linear-control placeholder:text-linear-search-placeholder transition-[border-color] duration-150 ease-[ease] disabled:text-linear-muted",
        searchContent:
          "h-8 border-linear-search-content-border bg-linear-subtle py-1.5 pl-8 pr-[25px] font-medium placeholder:text-linear-select-chevron transition-[border-color] duration-150 ease-[ease] hover:border-linear-search-content-border-hover focus:border-linear-search-content-border-hover disabled:text-linear-select-chevron disabled:hover:border-linear-search-content-border data-[preview=hover]:border-linear-search-content-border-hover",
      },
    },
    defaultVariants: {
      variant: "standard",
    },
  },
)

type InputProps = React.ComponentPropsWithoutRef<"input"> &
  VariantProps<typeof inputVariants>

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", variant, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ variant, className }))}
      {...props}
    />
  ),
)
Input.displayName = "Input"

function SearchIcon(props: React.ComponentPropsWithoutRef<"svg">) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7 2C9.76142 2 12 4.23858 12 7C12 8.11012 11.6375 9.13519 11.0254 9.96484L13.7803 12.7197L13.832 12.7764C14.0723 13.0709 14.0549 13.5057 13.7803 13.7803C13.5057 14.0549 13.0709 14.0723 12.7764 13.832L12.7197 13.7803L9.96484 11.0254C9.13519 11.6375 8.11012 12 7 12C4.23858 12 2 9.76142 2 7C2 4.23858 4.23858 2 7 2ZM7 3.5C5.067 3.5 3.5 5.067 3.5 7C3.5 8.933 5.067 10.5 7 10.5C8.933 10.5 10.5 8.933 10.5 7C10.5 5.067 8.933 3.5 7 3.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ClearIcon(props: React.ComponentPropsWithoutRef<"svg">) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M2.96967 2.96967C3.26256 2.67678 3.73744 2.67678 4.03033 2.96967L8 6.939L11.9697 2.96967C12.2626 2.67678 12.7374 2.67678 13.0303 2.96967C13.3232 3.26256 13.3232 3.73744 13.0303 4.03033L9.061 8L13.0303 11.9697C13.2966 12.2359 13.3208 12.6526 13.1029 12.9462L13.0303 13.0303C12.7374 13.3232 12.2626 13.3232 11.9697 13.0303L8 9.061L4.03033 13.0303C3.73744 13.3232 3.26256 13.3232 2.96967 13.0303C2.67678 12.7374 2.67678 12.2626 2.96967 11.9697L6.939 8L2.96967 4.03033C2.7034 3.76406 2.6792 3.3474 2.89705 3.05379L2.96967 2.96967Z"
        fill="currentColor"
      />
    </svg>
  )
}

type SearchInputProps = Omit<InputProps, "type" | "variant"> & {
  clearLabel?: string
  containerClassName?: string
  variant?: "sidebar" | "content"
}

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value)
    return
  }

  if (ref) {
    ref.current = value
  }
}

const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      "aria-label": ariaLabel,
      autoComplete = "off",
      className,
      clearLabel = "Clear",
      containerClassName,
      defaultValue,
      disabled,
      enterKeyHint = "search",
      inputMode = "search",
      onChange,
      placeholder,
      readOnly,
      spellCheck = false,
      value,
      variant = "sidebar",
      ...props
    },
    forwardedRef,
  ) => {
    const inputRef = React.useRef<HTMLInputElement>(null)
    const [uncontrolledHasValue, setUncontrolledHasValue] = React.useState(
      () => String(defaultValue ?? "").length > 0,
    )
    const hasValue =
      value !== undefined ? String(value).length > 0 : uncontrolledHasValue

    function setInputRef(node: HTMLInputElement | null) {
      inputRef.current = node
      assignRef(forwardedRef, node)
    }

    function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
      setUncontrolledHasValue(event.currentTarget.value.length > 0)
      onChange?.(event)
    }

    function clearInput() {
      const input = inputRef.current

      if (!input) {
        return
      }

      const valueDescriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )
      const valueSetter = Reflect.get(valueDescriptor ?? {}, "set") as
        | ((this: HTMLInputElement, value: string) => void)
        | undefined

      valueSetter?.call(input, "")
      input.dispatchEvent(new Event("input", { bubbles: true }))
      setUncontrolledHasValue(false)
      input.focus()
    }

    return (
      <div className={cn("relative", containerClassName)}>
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-linear-search-icon" />
        <Input
          ref={setInputRef}
          type="search"
          variant={variant === "sidebar" ? "searchSidebar" : "searchContent"}
          aria-label={ariaLabel ?? placeholder}
          autoComplete={autoComplete}
          className={className}
          defaultValue={defaultValue}
          disabled={disabled}
          enterKeyHint={enterKeyHint}
          inputMode={inputMode}
          onChange={handleChange}
          placeholder={placeholder}
          readOnly={readOnly}
          spellCheck={spellCheck}
          value={value}
          data-1p-ignore="true"
          data-linear-search-input=""
          {...props}
        />
        {hasValue && !disabled && !readOnly ? (
          <button
            type="button"
            tabIndex={-1}
            className={cn(
              "absolute right-[3px] top-1/2 z-10 size-[22px] -translate-y-1/2 border-0 bg-transparent p-[5px] outline-none",
              variant === "sidebar"
                ? "text-linear-search-icon"
                : "text-linear-select-chevron",
            )}
            aria-label={clearLabel}
            onClick={clearInput}
          >
            <ClearIcon className="size-3" />
          </button>
        ) : null}
      </div>
    )
  },
)
SearchInput.displayName = "SearchInput"

export {
  SearchInput,
}
