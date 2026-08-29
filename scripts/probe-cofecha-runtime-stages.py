"""Capture COFECHA 6.06 float arrays at its filtering routine boundaries."""

from __future__ import annotations

import argparse
import json
import shutil
import threading
from pathlib import Path

import frida


HOOK_SCRIPT = r"""
const base = Process.mainModule.base;
const calls = {
    spline: 0,
    divser: 0,
    varianceStabilize: 0,
    standardize: 0,
    ar: 0,
    stats: 0,
    pearson: 0,
    segmentPearson: 0,
    segmentEvaluation: 0,
    part6IssueScan: 0,
};

function readFloatArray(address, length) {
    const values = [];
    for (let index = 0; index < length; index += 1) {
        values.push(address.add(index * 4).readFloat());
    }
    return values;
}

Interceptor.attach(base.add(0xd620), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.source = args[1];
        this.output = args[2];
        this.payload = {
            stage: "spline",
            call: ++calls.spline,
            length: this.length,
            rigidityYears: args[3].readFloat(),
            frequencyResponse: args[4].readFloat(),
            input: readFloatArray(this.source, this.length),
        };
    },
    onLeave() {
        this.payload.output = readFloatArray(this.output, this.length);
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xd708), {
    onEnter() {
        send({
            stage: "splinePenalty",
            value: base.add(0x19d008).readDouble(),
        });
    },
});

Interceptor.attach(base.add(0xe178), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.output = args[3];
        this.payload = {
            stage: "divser",
            call: ++calls.divser,
            length: this.length,
            source: readFloatArray(args[1], this.length),
            curve: readFloatArray(args[2], this.length),
        };
    },
    onLeave() {
        this.payload.output = readFloatArray(this.output, this.length);
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xe4da), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.series = args[1];
        this.payload = {
            stage: "varianceStabilize",
            call: ++calls.varianceStabilize,
            length: this.length,
            rigidityYears: args[2].readS32(),
            input: readFloatArray(this.series, this.length),
        };
    },
    onLeave() {
        this.payload.output = readFloatArray(this.series, this.length);
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xe765), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.series = args[1];
        this.meanAddress = args[2];
        this.sdAddress = args[3];
        this.payload = {
            stage: "standardize",
            call: ++calls.standardize,
            callerOffset: this.returnAddress.sub(base).toString(),
            length: this.length,
            degreesOfFreedomAdjustment: args[4].readS32(),
            input: readFloatArray(this.series, this.length),
        };
    },
    onLeave() {
        this.payload.mean = this.meanAddress.readFloat();
        this.payload.standardDeviation = this.sdAddress.readFloat();
        this.payload.output = readFloatArray(this.series, this.length);
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xeb08), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.input = args[1];
        this.output = args[13];
        this.scalarAddresses = [];
        for (let index = 5; index <= 12; index += 1) {
            this.scalarAddresses.push(args[index]);
        }
        this.workAddresses = [args[2], args[3], args[4]];
        this.payload = {
            stage: "ar",
            call: ++calls.ar,
            length: this.length,
            input: readFloatArray(this.input, this.length),
        };
    },
    onLeave() {
        this.payload.centeredInput = readFloatArray(this.input, this.length);
        this.payload.output = readFloatArray(this.output, this.length);
        this.payload.scalars = this.scalarAddresses.map((address) => ({
            intValue: address.readS32(),
            floatValue: address.readFloat(),
        }));
        this.payload.parameterHeads = this.scalarAddresses.map((address) => (
            readFloatArray(address, 16)
        ));
        this.payload.workArrayHeads = this.workAddresses.map((address) => (
            readFloatArray(address, Math.min(this.length, 16))
        ));
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xd08b), {
    onEnter(args) {
        this.payload = {
            stage: "stats",
            call: ++calls.stats,
            callerOffset: this.returnAddress.sub(base).toString(),
            length: args[0].readS32(),
        };
        this.outputs = [args[2], args[3], args[4], args[5], args[6]];
    },
    onLeave() {
        this.payload.mean = this.outputs[0].readFloat();
        this.payload.maximum = this.outputs[1].readFloat();
        this.payload.minimum = this.outputs[2].readFloat();
        this.payload.meanSensitivity = this.outputs[3].readFloat();
        this.payload.standardDeviation = this.outputs[4].readFloat();
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xd2d2), {
    onEnter(args) {
        this.output = args[3];
        this.length = args[0].readS32();
        this.left = args[1];
        this.right = args[2];
        this.payload = {
            stage: "pearson",
            call: ++calls.pearson,
            callerOffset: this.returnAddress.sub(base).toString(),
            length: args[0].readS32(),
        };
    },
    onLeave() {
        this.payload.correlation = this.output.readFloat();
        this.payload.leftSum = base.add(0x19cfbc).readFloat();
        this.payload.rightSum = base.add(0x19cfc0).readFloat();
        this.payload.cross = base.add(0x19cfc8).readFloat();
        this.payload.leftSquares = base.add(0x19cfcc).readFloat();
        this.payload.rightSquares = base.add(0x19cfb4).readFloat();
        this.payload.reciprocal = base.add(0x19cfc4).readFloat();
        if (this.payload.callerOffset === "0x932a") {
            this.payload.left = readFloatArray(this.left, this.length);
            this.payload.right = readFloatArray(this.right, this.length);
        }
        send(this.payload);
    },
});

Interceptor.attach(base.add(0x171da), {
    onEnter(args) {
        if (!this.returnAddress.equals(base.add(0x11172))) return;
        this.active = true;
        this.length = args[0].readS32();
        this.output = args[5];
        this.payload = {
            stage: "segmentPearson",
            call: ++calls.segmentPearson,
            length: this.length,
            left: readFloatArray(args[1], this.length),
            right: readFloatArray(args[2], this.length),
            mask: Array.from(new Uint8Array(args[3].readByteArray(this.length))),
        };
    },
    onLeave() {
        if (!this.active) return;
        this.payload.correlation = this.output.readFloat();
        send(this.payload);
    },
});

Interceptor.attach(base.add(0x1101a), {
    onEnter(args) {
        this.payload = {
            stage: "segmentEvaluation",
            call: ++calls.segmentEvaluation,
            rawArgs: Array.from({ length: 20 }, (_, index) => args[index].toUInt32()),
        };
    },
    onLeave() {
        this.payload.correlations = readFloatArray(base.add(0x19d4c0), 21);
        this.payload.bestLagIndex = base.add(0x19d434).readS32();
        this.payload.bestCorrelation = base.add(0x19d430).readFloat();
        send(this.payload);
    },
});

Interceptor.attach(base.add(0x9c8e), {
    onEnter() {
        send({
            stage: "reportAverages",
            seriesCount: base.add(0x19caa0).readS32(),
            correlationDenominator: base.add(0x19caec).readS32(),
            values: [
                0x19cb84,
                0x19cb58,
                0x19caa8,
                0x19c9ec,
                0x19cb7c,
                0x19cae0,
                0x19cc54,
            ].map((offset) => base.add(offset).readFloat()),
        });
    },
});

Interceptor.attach(base.add(0xf4e0), {
    onEnter(args) {
        this.startYear = args[2].readS32();
        this.endYear = args[3].readS32();
        this.length = this.endYear - this.startYear + 1;
        this.payload = {
            stage: "part6IssueScan",
            call: ++calls.part6IssueScan,
            startYear: this.startYear,
            endYear: this.endYear,
            seriesNumber: args[9].readS32(),
            mode: args[10].readUtf8String(1),
            scalar: args[6].readFloat(),
            left: readFloatArray(args[4], this.length),
            right: readFloatArray(args[5], this.length),
        };
    },
    onLeave() {
        this.payload.issueCount = base.add(0x19d1f8).readS32();
        send(this.payload);
    },
});
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cofecha-exe", required=True, type=Path)
    parser.add_argument("--rwl", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--job", default="TRACE")
    parser.add_argument(
        "--profile",
        choices=("plain", "logon", "arraw", "full"),
        default="plain",
    )
    parser.add_argument("--spline-years", type=int, default=32)
    parser.add_argument("--segment-length", type=int, default=50)
    parser.add_argument("--segment-lag", type=int, default=25)
    parser.add_argument(
        "--correlation-method",
        choices=("pearson", "spearman"),
        default="pearson",
    )
    parser.add_argument("--critical-correlation", type=float)
    parser.add_argument("--include-absent-rings", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    runtime_name = "INPUT.RWL"
    shutil.copyfile(args.rwl, args.output_dir / runtime_name)

    device = frida.get_local_device()
    records: list[dict[str, object]] = []
    process_output: list[dict[str, object]] = []
    detached = threading.Event()

    def on_output(pid: int, fd: int, data: bytes) -> None:
        process_output.append({
            "pid": pid,
            "fd": fd,
            "text": data.decode("utf-8", errors="replace"),
        })

    device.on("output", on_output)
    pid = device.spawn(
        [str(args.cofecha_exe)],
        cwd=str(args.output_dir),
        stdio="pipe",
    )
    session = device.attach(pid)
    session.on("detached", lambda *_: detached.set())
    script = session.create_script(HOOK_SCRIPT)

    def on_message(message: dict[str, object], _data: bytes | None) -> None:
        if message.get("type") == "send":
            payload = message.get("payload")
            if isinstance(payload, dict):
                records.append(payload)
        else:
            records.append({"stage": "frida-message", "message": message})

    script.on("message", on_message)
    script.load()
    device.resume(pid)
    prompt_lines = [
        args.job[:5].upper(),
        runtime_name,
        "",
        "",
        "",
    ]
    if args.spline_years != 32:
        prompt_lines.extend(("1", str(args.spline_years), ""))
    if args.segment_length != 50 or args.segment_lag != 25:
        prompt_lines.extend((
            "2",
            str(args.segment_length),
            str(args.segment_lag),
        ))
    if args.profile in ("plain", "logon"):
        prompt_lines.extend(("3", "N"))
    if args.profile in ("plain", "arraw"):
        prompt_lines.extend(("4", "N"))
    if args.correlation_method != "pearson" or args.critical_correlation is not None:
        prompt_lines.extend((
            "5",
            "S" if args.correlation_method == "spearman" else "P",
            "" if args.critical_correlation is None else str(args.critical_correlation),
        ))
    if args.include_absent_rings:
        prompt_lines.extend(("9", "N"))
    prompt_lines.extend(("6", "V", "", ""))
    prompt = "\n".join(prompt_lines).encode("ascii")
    device.input(pid, prompt)
    if not detached.wait(120):
        device.kill(pid)
        raise TimeoutError("COFECHA runtime probe timed out")

    output = {
        "schemaVersion": 1,
        "cofechaExe": str(args.cofecha_exe.resolve()),
        "sourceRwl": str(args.rwl.resolve()),
        "profile": args.profile,
        "records": records,
        "processOutput": process_output,
    }
    output_path = args.output_dir / "runtime-stages.json"
    output_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"COFECHA_RUNTIME_STAGES_COMPLETE {output_path}")


if __name__ == "__main__":
    main()
