# RLS1000 / Rongta scale — PLU download protocol (reverse-engineered)

Status: **empirically derived from live captures**, not from vendor documentation.
Reference implementation: `packages/plu-format` + `packages/scale-client` (byte-for-byte
golden tests against the captures).

Evidence:

| Capture | File | Result |
|---|---|---|
| 832-PLU production file | `docs/captures/scale-udp-plu-download.pcapng` | transfer ACKed, **scale discarded everything**, vendor app reported `Error de Plu` |
| 10-PLU clean file | `docs/captures/scale-udp-plu-test10-success.pcapng` | **PLUs confirmed present on the scale** |

**The 10-PLU capture is the golden reference.** The protocol below is verified end to end:
our implementation reproduces every captured byte and the resulting transfer is accepted.

Every statement is either **verified** against a capture or explicitly marked **unknown**.
Do not promote an unknown item to verified without a new capture.

---

## 1. Transport

| Item | Value | Confidence |
|---|---|---|
| Protocol | **UDP** (connectionless, no transport handshake) | verified |
| Scale port | **5001** | verified |
| Client port | ephemeral (observed: 63653) | verified |
| Client → scale payload | 265 bytes (`0xD2` frames) / 261 bytes (`0x0E` frames) | verified |
| Scale → client ACK | **zero-length UDP payload** | verified |
| Retransmission | none observed from the scale; the client retries | verified |

The scale acknowledges **each** request with an **empty UDP datagram**. There is no per-packet
status code and no commit confirmation, so a missing ACK is the only failure signal.

> Port `5001` also accepts TCP connections, which makes a TCP port scan misleading.
> Port `4001` is a **mirror/monitor port**: it echoes anything sent to it and leaks LAN
> broadcast traffic (DHCP observed). It is not part of the PLU protocol.
> Port `5002` exists but was not used during a PLU download.

## 2. Frame format

```
byte 0        byte 1      ...                                last 2 bytes
+-------------+-----------+----------------------------------+------------------+
| 0x0E / 0xD2 | sub-command | fixed-size zero-padded content | uint16 LE checksum |
+-------------+-----------+----------------------------------+------------------+
```

* **Checksum** — last 2 bytes, little-endian uint16, equal to the **sum of every preceding byte**
  (offsets `0 .. n-3`) truncated to 16 bits. It is a plain additive checksum, **not** a CRC.
  Verified on every captured frame; the implementation asserts it in its test suite.

| Class | Payload size | UDP length |
|---|---|---|
| `0x0E` (session) | **261** bytes | 269 |
| `0xD2` (data) | **265** bytes | 273 |

Both classes are fixed size and zero padded; the checksum always occupies the last two bytes.

## 3. Session sequence

Verified complete sequence for one PLU download (10-PLU file, PLUs confirmed on the device):

| # | Frame | Notes |
|---|---|---|
| 1 | `0E 01` | hello |
| 2 | `D2 01` | start transfer |
| 3 | `D2 02` × N | data, sequence byte 0..N-1, wraps at 256 |
| 4 | `D2 04` × 3 | keyboard-slot table (see §5) |
| 5 | `D2 07` × 2 | commit |
| 6 | `D2 05` | end |
| 7 | `D2 0C` | end |
| 8 | `0E 02` | goodbye |

Timing on the 832-PLU run: 416 data frames in ~16 s (~26 datagrams/s).

### 3.1 `0E 01` — hello

```
0E 01 00 34 12 00 00 DD MM YY hh mm ss 00 00 "RONGTA_PV2.0\0" 00 ... [sum]
         |           |  |  |  |  |  |
         |           |  |  |  |  +-- seconds, packed BCD (0x03)
         |           |  |  |  +----- minutes  (0x25)
         |           |  |  +-------- hours    (0x13)
         |           +--+----------- year, month, day as packed BCD (0x26 0x10 0x26)
         +-- magic 0x1234 little-endian
```

Byte offsets: `[0]=0E [1]=01 [2]=00 [3..4]=34 12 [5..6]=00 00 [7..12]=date/time
[13..14]=00 00 [15..]=model string NUL-padded to 259 [259..260]=checksum`.

Scale reply: **263-byte** payload starting `0E 01 00` followed by its model string
(`RONGTA_PV2.0`). The reply's own trailing bytes were not isolated (`40 04 A5 49` observed).

### 3.2 `0E 02` — goodbye

Same 261-byte layout as hello, sub-command `0x02`, date/time zeroed, no model string.

### 3.3 `D2 01` — start

265 bytes: `D2 01 00 01 00 00 00` then zeros.

### 3.4 `D2 02` — data

```
D2 02 00 <seq> 00 00 00 | <256-byte body> | [sum]
```

* `seq` — byte at offset 3, increments per data frame, **wraps at 256**.
* Body = **two 124-byte PLU records + 8 zero bytes of padding**.
* `832 records -> 416 data frames`, exactly the PLU count of the source file.

## 4. PLU record — 124 bytes

Verified **byte-for-byte for all 832 records** of the production file against the captured
stream (`packages/plu-format/test/fixtures/expected-records-832.bin`).

| Offset | Size | Field | Encoding | Verified |
|---|---|---|---|---|
| 0 | 72 | name | ASCII, space padded (`0x20`) | yes |
| 72 | 1 | reserved | always `0x00` | yes |
| 73 | 2 | LF code / PLU key | BCD big-endian (`00 01` = 1, `08 32` = 832) | yes |
| 75 | 2 | reserved | always `0x00 0x00` | yes |
| 77 | 3 | barcode | BCD big-endian, 6 digits (`01 10 01` = 11001) | yes |
| 80 | 1 | barcode type | binary (`7` in every verified record) | yes |
| 81 | 2 | reserved | always `0x00 0x00` | yes |
| 83 | 2 | unit price | BCD, cents (`14 50` = 14.50) | yes |
| 85 | 1 | unit code (grid "Unidad") | binary (`4` = kg, `9`/`10` = sold by unit) | yes |
| 86 | 1 | department (grid "Departamento") | BCD (`0x21` = 21) | yes |
| 87 | 3 | reserved | always `0x00 0x00 0x00` | yes |
| 90 | 2 | validity days (grid "Fecha de vali") | uint16 LE (`6D 01` = 365) | yes |
| 92 | 1 | package flag | `0x00` when `.Txp` column 10 = 0, `0x80` when column 10 = 2 | yes |
| 93 | 31 | unresolved | zero in every captured record | unknown |

Notes:

* The name area holds a **41-character** name in full (line 798 of the production file), so the
  72-byte area is a single text field, not `40 + 32`. The vendor grid simply displays 40.
* The `0x80` flag at offset 92 correlates perfectly (158/158) with `.Txp` column 10 = `2`
  (bakery / by-unit articles). Column 10 values other than `0` and `2` were never observed,
  so the validator rejects them as unverified.
* Bytes 93..123 stay zero for every article in this catalog. They are the remaining gap: a
  capture with a non-zero tare, pack price, message or rebate is required to map them.

### 4.1 Weight unit (byte 85)

The vendor grid offers exactly these 13 options under "Unidad de peso", in this order.
The record stores the **0-based index** of the selected option.

| Code | Unit | Confirmed on the wire |
|---|---|---|
| 0 | 50g | no (inferred from dropdown order) |
| 1 | g | no |
| 2 | 10g | no |
| 3 | 100g | no |
| **4** | **kg** | **yes — every kg article in the production file** |
| 5 | oz | no |
| 6 | lb | no |
| 7 | 500g | no |
| 8 | 600g | no |
| **9** | **PCS(g)** | **yes — by-unit articles** |
| **10** | **PCS(kg)** | **yes — by-unit articles** |
| 11 | PCS(oz) | no |
| 12 | PCS(lb) | no |

The catalogue only used codes 4, 9 and 10, which is why the mapping is pinned to the dropdown
order rather than to direct observation of every option. The validator accepts 0..12, rejects
anything else, and warns for the codes that have not been seen on hardware.

The unit travels with the article: cloud config -> agent -> record byte 85. In the web layer it
should be stored and edited with the same 13 identifiers (`kg`, `pcs_kg`, `50g`, …) so no
translation happens outside `packages/plu-format`.

## 5. `D2 04` — keyboard-slot table

Three frames, 85 entries each, header `D2 04 00 F8|F9|FA 03 00 00`, entries are 3-byte
packed-BCD values in ascending order.

Verified against both captures:

| Run | Table content |
|---|---|
| 10 PLUs | 1..10 |
| 832 PLUs | 1..84, 85..168, 169..224 |

The values match the `.Txp` "Teclado" column (keyboard slot numbers), which only reaches 224
in this catalog — hence the table stops there even though the file has 832 PLUs.

The third frame contains additional non-BCD bytes whose meaning is **unknown**; the reference
implementation reproduces frames 1 and 2 from the slot numbers and replays frame 3 verbatim
from the verified capture.

## 6. `D2 07` / `D2 05` / `D2 0C` — closing frames

All 265 bytes, zero padded except the noted bytes:

| Frame | Header bytes 3..4 | Body |
|---|---|---|
| `D2 07` (first) | `F6 03` | `body[0] = 0xFF` |
| `D2 07` (second) | `F7 03` | `body[0] = 0xFF` |
| `D2 05` | `00 00` | `body[0] = 0xFF` |
| `D2 0C` | `09 00` | `0x64` at every odd body offset from 157 |

The two `D2 07` frames differ only in that counter byte. Their individual roles are **unknown**;
the exact combination is required, since this is what the successful capture sent.

## 7. Known unknowns

1. Meaning of the `D2 04` third frame (non-BCD content).
2. Bytes 93..123 of the PLU record (tare / pack price / messages / rebate).
3. Whether `D2 04` is required at all, and whether the two `D2 07` frames are both necessary.
4. The scale never reports a commit status; success is ACK-based only.
5. Unit codes: only `4` (kg) and `9`/`10` (by unit) were observed.

## 8. Data validation is a product requirement

The 832-PLU file transferred completely and every datagram was ACKed, yet the scale applied
nothing and the vendor app reported `Error de Plu`. The clean 10-PLU file worked immediately.
The failing file contained:

| Defect | Count | Examples |
|---|---|---|
| Duplicated barcode | 4 | `12200` lines 100/200, `12245` 30/245, `12654` 653/654, `12754` 751/754 |
| Zero price | 23 | lines 17, 21, 33, 34, 183, 193, 213 … (mostly `INACTIVO` placeholders) |
| Name longer than 40 chars | 1 | line 798, 41 chars (transmitted intact; treated as a warning) |

Which class actually triggered the abort is **not isolated**. The validator blocks duplicate
barcodes and treats zero prices / long names as warnings, so the operator sees them before
publishing. Isolating the exact rule requires a targeted push from our own client, which is
cheap now that the CLI exists.

## 9. Reference implementation

```
packages/plu-format    .Txp parsing, 124-byte records, frame builders, validation
packages/scale-client  UDP transport with ACK + retry
apps/cli               balanza validate | build | probe | push
```

`node apps/cli/src/index.js push <file.txp> --ip <scale-ip>` performs a full transfer with no
vendor software involved.

**Live verification (2026-10-26):** a catalogue was pushed from this client to the scale with
distinctive prices (9.99, 8.88, … 1.00). The prices were confirmed on the device, without
RLS1000 running. The presence of the earlier test data was also confirmed this way.

Tests (`node --test`) include:

* 832-record golden comparison against the captured bytes,
* every control frame reproduced byte-for-byte,
* data frames for the 10-PLU file reproduced byte-for-byte,
* UDP transport against a fake scale (ACK, retry, timeout).

## 10. Differences from the vendor app worth keeping in our design

| Vendor app | Our client |
|---|---|
| Reports "communication finished" with an empty port, sends nothing | Never reports success without ACKs |
| Reports a generic `Error de Plu` and aborts | Validates before sending, with per-field messages |
| One global IP/port in `SYSTEM.CFG` | Per-scale IP + port from the cloud config |
| Blocking GUI, no retry policy | Timeout + bounded retries + structured log |
