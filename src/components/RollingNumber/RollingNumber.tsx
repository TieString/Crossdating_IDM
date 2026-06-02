import { useEffect, useRef, useState } from "react";
import style from "./RollingNumber.module.css";

interface RollingNumberProps {
    value: string | number | null | undefined;
    fromValue?: string | number | null;
    placeholder?: string;
    stagger?: number;
}

interface RollingDigitProps {
    digit: number;
    delay: number;
    initialDigit?: number;
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function RollingDigit({ digit, delay, initialDigit }: RollingDigitProps) {
    const [display, setDisplay] = useState(initialDigit ?? digit);
    const isFirst = useRef(true);

    useEffect(() => {
        const updateDisplay = () => setDisplay(digit);

        if (isFirst.current) {
            isFirst.current = false;

            if (initialDigit === undefined || initialDigit === digit) {
                setDisplay(digit);
                return;
            }
        }

        if (delay <= 0) {
            updateDisplay();
            return;
        }

        const timer = window.setTimeout(updateDisplay, delay);
        return () => window.clearTimeout(timer);
    }, [digit, delay, initialDigit]);

    return (
        <span className={style.digit}>
            <span
                className={style["digit-reel"]}
                style={{ transform: `translateY(-${display * 1.2}em)` }}
            >
                {DIGITS.map((d) => (
                    <span key={d}>{d}</span>
                ))}
            </span>
        </span>
    );
}

export function RollingNumber({ value, fromValue, placeholder = "-", stagger = 60 }: RollingNumberProps) {
    if (value === null || value === undefined || value === "") {
        return <span className={`${style.rolling} ${style.placeholder}`}>{placeholder}</span>;
    }

    const text = String(value);
    const initialText = fromValue === null || fromValue === undefined || fromValue === "" ? "" : String(fromValue);
    const alignedInitialText = initialText.length > text.length
        ? initialText.slice(initialText.length - text.length)
        : initialText.padStart(text.length, " ");
    const chars = [...text];
    const initialChars = [...alignedInitialText];
    const digitIndexes: number[] = [];
    chars.forEach((ch, index) => {
        if (ch >= "0" && ch <= "9") digitIndexes.push(index);
    });

    return (
        <span className={style.rolling}>
            {chars.map((ch, index) => {
                if (ch >= "0" && ch <= "9") {
                    const order = digitIndexes.indexOf(index);
                    const initialChar = initialChars[index];
                    const initialDigit = typeof initialChar === "string" && initialChar >= "0" && initialChar <= "9"
                        ? Number.parseInt(initialChar, 10)
                        : undefined;
                    return (
                        <RollingDigit
                            key={`d-${index}`}
                            digit={Number.parseInt(ch, 10)}
                            delay={order * stagger}
                            initialDigit={initialDigit}
                        />
                    );
                }
                return (
                    <span key={`s-${index}`} className={style["static-char"]}>
                        {ch}
                    </span>
                );
            })}
        </span>
    );
}

export default RollingNumber;
