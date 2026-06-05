import { useEffect, useRef, useState, type CSSProperties } from "react";
import style from "./RollingNumber.module.css";

interface RollingNumberProps {
    value: string | number | null | undefined;
    fromValue?: string | number | null;
    placeholder?: string;
    stagger?: number;
    speed?: number;
}

interface RollingDigitProps {
    digit: number;
    delay: number;
    initialDigit?: number;
    durationMs: number;
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const DEFAULT_ROLL_DURATION_MS = 2000;

const normalizeAnimationSpeed = (speed: number) => (
    Number.isFinite(speed) && speed > 0 ? speed : 1
);

function RollingDigit({ digit, delay, initialDigit, durationMs }: RollingDigitProps) {
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
                style={{
                    transform: `translateY(-${display * 1.2}em)`,
                    "--rolling-duration": `${durationMs}ms`,
                } as CSSProperties}
            >
                {DIGITS.map((d) => (
                    <span key={d}>{d}</span>
                ))}
            </span>
        </span>
    );
}

export function RollingNumber({ value, fromValue, placeholder = "-", stagger = 60, speed = 1 }: RollingNumberProps) {
    if (value === null || value === undefined || value === "") {
        return <span className={`${style.rolling} ${style.placeholder}`}>{placeholder}</span>;
    }

    const animationSpeed = normalizeAnimationSpeed(speed);
    const durationMs = Math.max(1, Math.round(DEFAULT_ROLL_DURATION_MS / animationSpeed));
    const staggerMs = Math.max(0, stagger / animationSpeed);
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
                            delay={order * staggerMs}
                            initialDigit={initialDigit}
                            durationMs={durationMs}
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
