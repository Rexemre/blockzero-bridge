/**
 * Offline validation of Block Zero addresses (bech32/bech32m, hrp "bz") for the unwrap form.
 * Mirror of relayer/src/bz1.ts — keep both in sync (relayer/test/bz1.test.mjs checks both).
 * Browser: window.checkBz1Address(addr). Node (tests): module.exports.checkBz1Address.
 */
(function (root) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const HRP = "bz";

  function polymod(values) {
    const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ gen[i]) >>> 0;
    }
    return chk;
  }

  function hrpExpand(hrp) {
    const out = [];
    for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
    out.push(0);
    for (const c of hrp) out.push(c.charCodeAt(0) & 31);
    return out;
  }

  function convertBits(data, from, to) {
    let acc = 0;
    let bits = 0;
    const out = [];
    const maxv = (1 << to) - 1;
    for (const v of data) {
      acc = (acc << from) | v;
      bits += from;
      while (bits >= to) {
        bits -= to;
        out.push((acc >> bits) & maxv);
      }
    }
    if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) return null;
    return out;
  }

  function checkBz1Address(input) {
    if (typeof input !== "string" || !input) return { valid: false, reason: "Address is empty." };
    const addr = input;
    if (/\s/.test(addr)) return { valid: false, reason: "Address contains spaces." };
    if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) {
      return { valid: false, reason: "Address mixes upper and lower case." };
    }
    const a = addr.toLowerCase();
    if (a.startsWith("0x")) return { valid: false, reason: "This is a BSC/EVM address. Enter your Block Zero address (bz1…)." };
    if (!a.startsWith(HRP + "1")) return { valid: false, reason: "Block Zero addresses start with bz1." };
    if (a.length < 14 || a.length > 90) return { valid: false, reason: "Address has the wrong length." };
    const data = a.slice(HRP.length + 1);
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      if (!CHARSET.includes(c)) {
        const hint =
          c === "1" ? ' — did you mean the letter "l"?' :
          c === "o" ? ' — did you mean the digit "0"?' :
          c === "b" || c === "i" ? " — this letter never appears in bz1 addresses" : "";
        return { valid: false, reason: `Invalid character "${c}" at position ${HRP.length + 2 + i}${hint}.` };
      }
    }
    const values = [...data].map((c) => CHARSET.indexOf(c));
    if (values.length < 7) return { valid: false, reason: "Address is too short." };
    const witnessVersion = values[0];
    if (witnessVersion > 16) return { valid: false, reason: "Unknown address version." };
    const constant = polymod([...hrpExpand(HRP), ...values]);
    const expected = witnessVersion === 0 ? 1 : 0x2bc830a3;
    if (constant !== expected) {
      return { valid: false, reason: "Checksum mismatch — the address has a typo. Copy it directly from your wallet." };
    }
    const program = convertBits(values.slice(1, -6), 5, 8);
    if (!program || program.length < 2 || program.length > 40) {
      return { valid: false, reason: "Address has an invalid witness program." };
    }
    if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) {
      return { valid: false, reason: "Address has an invalid witness program length." };
    }
    return { valid: true, witnessVersion };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { checkBz1Address };
  else root.checkBz1Address = checkBz1Address;
})(typeof window !== "undefined" ? window : globalThis);
