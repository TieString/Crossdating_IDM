import { useEffect, useRef, useState } from "react";
import style from "./RollingNumber.module.css";

interface RollingNumberProps {
    value: string | number | null | undefined;
    placeholder?: string;
    stagger?: number;
}

interface RollingDigitProps {
    digit: number;
    delay: number;
}

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function RollingDigit({ digit, delay }: RollingDigitProps) {
    const [display, setDisplay] = useState(digit);
    const isFirst = useRef(true);

    useEffect(() => {
        if (isFirst.current) {
            isFirst.current = false;
            setDisplay(digit);
            return;
        }
        if (delay <= 0) {
            setDisplay(digit);
            return;
        }
        const timer = window.setTimeout(() => setDisplay(digit), delay);
        return () => window.clearTimeout(timer);
    }, [digit, delay]);

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

export function RollingNumber({ value, placeholder = "-", stagger = 60 }: RollingNumberProps) {
    if (value === null || value === undefined || value === "") {
        return <span className={`${style.rolling} ${style.placeholder}`}>{placeholder}</span>;
    }

    const text = String(value);
    const chars = [...text];
    const digitIndexes: number[] = [];
    chars.forEach((ch, index) => {
        if (ch >= "0" && ch <= "9") digitIndexes.push(index);
    });

    return (
        <span className={style.rolling}>
            {chars.map((ch, index) => {
                if (ch >= "0" && ch <= "9") {
                    const order = digitIndexes.indexOf(index);
                    return (
                        <RollingDigit
                            key={`d-${index}`}
                            digit={Number.parseInt(ch, 10)}
                            delay={order * stagger}
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
