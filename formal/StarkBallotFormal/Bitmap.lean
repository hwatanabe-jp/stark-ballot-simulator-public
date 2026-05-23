import StarkBallotFormal.Basic

namespace StarkBallotFormal

def packedByteCount (bitLength : Nat) : Nat :=
  (bitLength + 7) / 8

def packedAddress (bitIndex : Nat) : Nat × Nat :=
  (bitIndex / 8, bitIndex % 8)

def packedBitValue (bits : List Bool) (bitIndex : Nat) : Bool :=
  bits.getD bitIndex false

def byteValueAt (bits : List Bool) (byteIndex : Nat) : Nat :=
  (if packedBitValue bits (byteIndex * 8 + 0) then 1 else 0) +
    (if packedBitValue bits (byteIndex * 8 + 1) then 2 else 0) +
    (if packedBitValue bits (byteIndex * 8 + 2) then 4 else 0) +
    (if packedBitValue bits (byteIndex * 8 + 3) then 8 else 0) +
    (if packedBitValue bits (byteIndex * 8 + 4) then 16 else 0) +
    (if packedBitValue bits (byteIndex * 8 + 5) then 32 else 0) +
    (if packedBitValue bits (byteIndex * 8 + 6) then 64 else 0) +
    (if packedBitValue bits (byteIndex * 8 + 7) then 128 else 0)

def packBits (bits : List Bool) : List Nat :=
  (List.range (packedByteCount bits.length)).map (byteValueAt bits)

def packedByteBitValue (byte bitIndexInByte : Nat) : Bool :=
  (byte / (2 ^ bitIndexInByte)) % 2 == 1

def getPackedBitModel (bits : List Bool) (bitIndex : Nat) : Bool :=
  packedBitValue bits bitIndex

theorem pack_bits_length (bits : List Bool) :
    (packBits bits).length = packedByteCount bits.length := by
  simp [packBits]

theorem bit_index_div_lt_packedByteCount
    {bitIndex bitLength : Nat}
    (hInRange : bitIndex < bitLength) :
    bitIndex / 8 < packedByteCount bitLength := by
  unfold packedByteCount
  omega

theorem packed_address_reconstructs_index (bitIndex : Nat) :
    (packedAddress bitIndex).fst * 8 + (packedAddress bitIndex).snd = bitIndex := by
  unfold packedAddress
  omega

theorem byteValueAt_get_bit
    (bits : List Bool)
    (byteIndex bitIndexInByte : Nat)
    (hInByte : bitIndexInByte < 8) :
    packedByteBitValue (byteValueAt bits byteIndex) bitIndexInByte =
      packedBitValue bits (byteIndex * 8 + bitIndexInByte) := by
  cases bitIndexInByte with
  | zero =>
      simp [packedByteBitValue, byteValueAt]
      generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
      generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
      generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
      generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
      generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
      generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
      generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
      generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
      cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
        cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
  | succ bit1 =>
      cases bit1 with
      | zero =>
          simp [packedByteBitValue, byteValueAt]
          generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
          generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
          generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
          generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
          generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
          generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
          generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
          generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
          cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
            cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
      | succ bit2 =>
          cases bit2 with
          | zero =>
              simp [packedByteBitValue, byteValueAt]
              generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
              generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
              generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
              generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
              generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
              generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
              generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
              generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
              cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
                cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
          | succ bit3 =>
              cases bit3 with
              | zero =>
                  simp [packedByteBitValue, byteValueAt]
                  generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
                  generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
                  generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
                  generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
                  generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
                  generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
                  generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
                  generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
                  cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
                    cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
              | succ bit4 =>
                  cases bit4 with
                  | zero =>
                      simp [packedByteBitValue, byteValueAt]
                      generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
                      generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
                      generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
                      generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
                      generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
                      generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
                      generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
                      generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
                      cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
                        cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
                  | succ bit5 =>
                      cases bit5 with
                      | zero =>
                          simp [packedByteBitValue, byteValueAt]
                          generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
                          generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
                          generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
                          generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
                          generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
                          generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
                          generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
                          generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
                          cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
                            cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
                      | succ bit6 =>
                          cases bit6 with
                          | zero =>
                              simp [packedByteBitValue, byteValueAt]
                              generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
                              generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
                              generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
                              generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
                              generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
                              generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
                              generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
                              generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
                              cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
                                cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
                          | succ bit7 =>
                              cases bit7 with
                              | zero =>
                                  simp [packedByteBitValue, byteValueAt]
                                  generalize h0 : packedBitValue bits (byteIndex * 8 + 0) = b0
                                  generalize h1 : packedBitValue bits (byteIndex * 8 + 1) = b1
                                  generalize h2 : packedBitValue bits (byteIndex * 8 + 2) = b2
                                  generalize h3 : packedBitValue bits (byteIndex * 8 + 3) = b3
                                  generalize h4 : packedBitValue bits (byteIndex * 8 + 4) = b4
                                  generalize h5 : packedBitValue bits (byteIndex * 8 + 5) = b5
                                  generalize h6 : packedBitValue bits (byteIndex * 8 + 6) = b6
                                  generalize h7 : packedBitValue bits (byteIndex * 8 + 7) = b7
                                  cases b0 <;> cases b1 <;> cases b2 <;> cases b3 <;>
                                    cases b4 <;> cases b5 <;> cases b6 <;> cases b7 <;> native_decide
                              | succ bit8 =>
                                  omega

theorem pack_bits_get_bit
    (bits : List Bool)
    (bitIndex : Nat)
    (hInRange : bitIndex < bits.length) :
    (packBits bits).getD (packedAddress bitIndex).fst 0 =
        byteValueAt bits (packedAddress bitIndex).fst ∧
      packedByteBitValue
          ((packBits bits).getD (packedAddress bitIndex).fst 0)
          (packedAddress bitIndex).snd =
        bits.get ⟨bitIndex, hInRange⟩ ∧
      getPackedBitModel bits ((packedAddress bitIndex).fst * 8 + (packedAddress bitIndex).snd) =
        bits.get ⟨bitIndex, hInRange⟩ := by
  constructor
  · unfold packBits packedAddress
    have hByte : bitIndex / 8 < packedByteCount bits.length :=
      bit_index_div_lt_packedByteCount hInRange
    simp [hByte]
  · constructor
    · have hByte : (packedAddress bitIndex).fst < packedByteCount bits.length :=
        bit_index_div_lt_packedByteCount hInRange
      have hBitInByte : (packedAddress bitIndex).snd < 8 := by
        unfold packedAddress
        exact Nat.mod_lt bitIndex (by decide)
      rw [show (packBits bits).getD (packedAddress bitIndex).fst 0 =
          byteValueAt bits (packedAddress bitIndex).fst by
        have hByteNat : bitIndex / 8 < packedByteCount bits.length :=
          bit_index_div_lt_packedByteCount hInRange
        unfold packBits packedAddress
        simp [hByteNat]]
      rw [byteValueAt_get_bit bits (packedAddress bitIndex).fst (packedAddress bitIndex).snd hBitInByte]
      rw [packed_address_reconstructs_index]
      exact (List.getElem_eq_getD (l := bits) (i := bitIndex) (h := hInRange) false).symm
    · rw [packed_address_reconstructs_index]
      unfold getPackedBitModel packedBitValue
      exact (List.getElem_eq_getD (l := bits) (i := bitIndex) (h := hInRange) false).symm

theorem packed_address_in_byte_bit_range (bitIndex : Nat) :
    (packedAddress bitIndex).snd < 8 := by
  unfold packedAddress
  exact Nat.mod_lt bitIndex (by decide)

theorem distinct_indices_distinct_packed_addresses
    {left right : Nat}
    (hDistinct : left ≠ right) :
    packedAddress left ≠ packedAddress right := by
  intro hAddress
  have hDiv : left / 8 = right / 8 := congrArg Prod.fst hAddress
  have hMod : left % 8 = right % 8 := congrArg Prod.snd hAddress
  have hEqual : left = right := by
    calc
      left = 8 * (left / 8) + left % 8 := (Nat.div_add_mod left 8).symm
      _ = 8 * (right / 8) + right % 8 := by rw [hDiv, hMod]
      _ = right := Nat.div_add_mod right 8
  exact hDistinct hEqual

end StarkBallotFormal
