package gateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
)

// ImportD1WithSourceKey supports an independently initialized installation.
// Only source ciphertext fields are rewrapped in memory with the destination
// encryption key; original snapshots and the saved configuration stay intact.
func (s *Store) ImportD1WithSourceKey(ctx context.Context, snapshot D1Snapshot, sourceKey string) (D1ImportResult, error) {
	if snapshot.Version != 1 || snapshot.Tables == nil {
		return D1ImportResult{}, errors.New("unsupported migration snapshot version")
	}
	if sourceKey == "" {
		return s.ImportD1(ctx, snapshot)
	}
	key, err := base64.StdEncoding.DecodeString(sourceKey)
	if err != nil || len(key) != 32 {
		return D1ImportResult{}, errors.New("SOURCE_ENCRYPTION_KEY must be the original base64 encoded 32 byte key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return D1ImportResult{}, errors.New("invalid source encryption key")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return D1ImportResult{}, errors.New("invalid source encryption key")
	}
	source := &Store{aead: aead}
	copySnapshot := snapshot
	copySnapshot.Tables = make(map[string][]map[string]json.RawMessage, len(snapshot.Tables))
	for table, rows := range snapshot.Tables {
		copySnapshot.Tables[table] = rows
	}
	for table, field := range map[string]string{"credentials": "secret", "channel_accounts": "credentials"} {
		rows := snapshot.Tables[table]
		copied := make([]map[string]json.RawMessage, len(rows))
		for index, row := range rows {
			if err := ctx.Err(); err != nil {
				return D1ImportResult{}, err
			}
			plain, err := source.Decrypt(d1Text(row, field))
			if err != nil {
				return D1ImportResult{}, errors.New("snapshot decryption failed; supply the original SOURCE_ENCRYPTION_KEY")
			}
			secret, err := s.Encrypt(plain)
			if err != nil {
				return D1ImportResult{}, errors.New("snapshot secret re-encryption failed")
			}
			copied[index] = make(map[string]json.RawMessage, len(row))
			for key, value := range row {
				copied[index][key] = value
			}
			copied[index][field] = d1JSON(secret)
		}
		copySnapshot.Tables[table] = copied
	}
	return s.ImportD1(ctx, copySnapshot)
}
