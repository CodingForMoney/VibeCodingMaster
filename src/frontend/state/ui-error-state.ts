import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { clearUiErrorMessage, reportUiError } from "./ui-error-events.js";

export function useUiErrorState(
  initialValue: string
): readonly [string, Dispatch<SetStateAction<string>>];
export function useUiErrorState(
  initialValue: string | null
): readonly [string | null, Dispatch<SetStateAction<string | null>>];
export function useUiErrorState<T extends string | null | undefined>(
  initialValue: T
): readonly [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initialValue);
  const valueRef = useRef<T>(initialValue);

  const setReportedValue = useCallback<Dispatch<SetStateAction<T>>>((nextValue) => {
    const currentValue = valueRef.current;
    const resolvedValue = typeof nextValue === "function"
      ? (nextValue as (current: T) => T)(currentValue)
      : nextValue;

    valueRef.current = resolvedValue;

    if (typeof resolvedValue === "string" && resolvedValue.trim()) {
      reportUiError(resolvedValue);
    } else if (typeof currentValue === "string" && currentValue.trim()) {
      clearUiErrorMessage(currentValue);
    }

    setValue(resolvedValue);
  }, []);

  return [value, setReportedValue];
}
