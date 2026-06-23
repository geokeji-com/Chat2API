package main

// Collect credentials from already-open BitBrowser windows for Chat2API providers.
//
// Usage:
//   go run scripts/bitbrowser_collect_credentials.go -out bitbrowser-credentials.json
//   go run scripts/bitbrowser_collect_credentials.go bitbrowser-credentials.json
//   go run scripts/bitbrowser_collect_credentials.go -store ~/.chat2api/data.json import bitbrowser-credentials.json
//
// The output contains live cookies/tokens. Keep it local and do not commit it.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const defaultBitAPI = "http://127.0.0.1:54345"

type providerSpec struct {
	ID               string
	Name             string
	Hosts            []string
	CookieFields     map[string][]string
	LocalFields      map[string][]string
	SessionFields    map[string][]string
	NeedsCookieHeader bool
	Extra            func(*providerResult, map[string]string, map[string]string, map[string]string)
}

type providerResult struct {
	Provider    string            `json:"provider"`
	Name        string            `json:"name"`
	Credentials map[string]string `json:"credentials"`
	Found       []string          `json:"found"`
	Missing     []string          `json:"missing"`
}

type windowResult struct {
	WindowID     string                     `json:"windowId,omitempty"`
	Name         string                     `json:"name,omitempty"`
	Status       string                     `json:"status,omitempty"`
	DebugAddress string                     `json:"debugAddress,omitempty"`
	PageURLs     []string                   `json:"pageUrls,omitempty"`
	Providers    []providerResult           `json:"providers"`
	Raw          *rawCredentialSnapshot      `json:"raw,omitempty"`
	Error        string                     `json:"error,omitempty"`
}

type rawCredentialSnapshot struct {
	Cookies        []cdpCookie              `json:"cookies,omitempty"`
	LocalStorage   map[string]map[string]string `json:"localStorage,omitempty"`
	SessionStorage map[string]map[string]string `json:"sessionStorage,omitempty"`
}

type outputDocument struct {
	Format      string         `json:"format"`
	Version     int            `json:"version"`
	GeneratedAt string         `json:"generatedAt"`
	BitAPI      string         `json:"bitApi"`
	Windows     []windowResult `json:"windows"`
}

type bitWindow struct {
	Raw          map[string]any
	ID           string
	Name         string
	Status       string
	DebugAddress string
}

type cdpCookie struct {
	Name     string  `json:"name"`
	Value    string  `json:"value"`
	Domain   string  `json:"domain"`
	Path     string  `json:"path,omitempty"`
	Expires  float64 `json:"expires,omitempty"`
	HTTPOnly bool    `json:"httpOnly,omitempty"`
	Secure   bool    `json:"secure,omitempty"`
}

type pageStorage struct {
	URL            string            `json:"url"`
	Origin         string            `json:"origin"`
	LocalStorage   map[string]string `json:"localStorage"`
	SessionStorage map[string]string `json:"sessionStorage"`
}

var providerSpecs = []providerSpec{
	{
		ID: "deepseek", Name: "DeepSeek", Hosts: []string{"chat.deepseek.com", "deepseek.com"},
		LocalFields: map[string][]string{"token": []string{"userToken"}},
	},
	{
		ID: "kimi", Name: "Kimi", Hosts: []string{"www.kimi.com", "kimi.com"}, NeedsCookieHeader: true,
		CookieFields: map[string][]string{"token": []string{"kimi-auth"}},
		LocalFields:  map[string][]string{"token": []string{"token", "access_token"}},
	},
	{
		ID: "doubao", Name: "Doubao", Hosts: []string{"www.doubao.com", "doubao.com"}, NeedsCookieHeader: true,
		CookieFields: map[string][]string{"sessionid": []string{"sessionid"}},
		Extra: func(result *providerResult, cookies, local, session map[string]string) {
			if v := firstNonEmpty(cookies["s_v_web_id"], findVerifyToken(local), findVerifyToken(session)); v != "" {
				result.Credentials["fp"] = v
			}
		},
	},
	{
		ID: "yuanbao", Name: "Yuanbao", Hosts: []string{"yuanbao.tencent.com"}, NeedsCookieHeader: true,
		CookieFields: map[string][]string{"hy_user": []string{"hy_user"}, "hy_token": []string{"hy_token"}},
	},
	{
		ID: "glm", Name: "GLM", Hosts: []string{"chatglm.cn"},
		CookieFields: map[string][]string{"refresh_token": []string{"chatglm_refresh_token"}},
		LocalFields:  map[string][]string{"refresh_token": []string{"chatglm_refresh_token"}},
	},
	{
		ID: "qwen", Name: "Qwen", Hosts: []string{"www.qianwen.com", "qianwen.com", "chat2.qianwen.com"}, NeedsCookieHeader: true,
		CookieFields: map[string][]string{"ticket": []string{"tongyi_sso_ticket"}, "csrfToken": []string{"x-csrf-token", "XSRF-TOKEN", "csrfToken"}, "umidToken": []string{"bx-umidtoken"}},
	},
	{
		ID: "minimax", Name: "MiniMax", Hosts: []string{"agent.minimaxi.com", "minimaxi.com"},
		LocalFields: map[string][]string{"token": []string{"_token", "token"}, "realUserID": []string{"realUserID"}},
		Extra: func(result *providerResult, _ map[string]string, local, _ map[string]string) {
			if result.Credentials["realUserID"] == "" {
				if userID := parseRealUserID(local["user_detail_agent"]); userID != "" {
					result.Credentials["realUserID"] = userID
				}
			}
		},
	},
	{
		ID: "zai", Name: "Z.ai", Hosts: []string{"chat.z.ai", "z.ai"},
		CookieFields: map[string][]string{"token": []string{"token"}},
		LocalFields:  map[string][]string{"token": []string{"token"}},
	},
	{
		ID: "mimo", Name: "Mimo", Hosts: []string{"aistudio.xiaomimimo.com", "xiaomimimo.com"},
		CookieFields: map[string][]string{"service_token": []string{"serviceToken"}, "user_id": []string{"userId"}, "ph_token": []string{"xiaomichatbot_ph"}},
	},
	{
		ID: "qwen-ai", Name: "Qwen AI", Hosts: []string{"chat.qwen.ai", "qwen.ai"}, NeedsCookieHeader: true,
		CookieFields: map[string][]string{"token": []string{"token"}},
		LocalFields:  map[string][]string{"token": []string{"token"}},
	},
	{
		ID: "perplexity", Name: "Perplexity", Hosts: []string{"www.perplexity.ai", "perplexity.ai"}, NeedsCookieHeader: true,
		CookieFields: map[string][]string{"sessionToken": []string{"__Secure-next-auth.session-token", "next-auth.session-token", "sessionToken"}},
	},
}

func main() {
	bitAPI := flag.String("bit-api", defaultBitAPI, "BitBrowser local API base URL")
	outFile := flag.String("out", "", "write collected credential JSON to this file")
	storeFile := flag.String("store", "", "Chat2API data.json path for import mode; defaults to ~/.chat2api/data.json")
	dryRun := flag.Bool("dry-run", false, "preview import changes without writing data.json")
	includeRaw := flag.Bool("include-raw", false, "include raw cookies/localStorage/sessionStorage in output")
	pageSize := flag.Int("page-size", 200, "BitBrowser /browser/list page size")
	timeout := flag.Duration("timeout", 15*time.Second, "HTTP and CDP timeout")
	flag.Parse()

	if flag.NArg() > 0 {
		inputPath := ""
		switch flag.NArg() {
		case 1:
			inputPath = flag.Arg(0)
		case 2:
			if flag.Arg(0) != "import" {
				log.Fatalf("unknown command %q; use no arguments to collect, or pass <credential-file> to import", flag.Arg(0))
			}
			inputPath = flag.Arg(1)
		default:
			log.Fatal("usage: bitbrowser_collect_credentials [-store ~/.chat2api/data.json] [-dry-run] [import] <credential-file>")
		}
		if err := importCredentials(inputPath, resolveStorePath(*storeFile), *dryRun); err != nil {
			log.Fatalf("import credentials: %v", err)
		}
		return
	}

	windows, err := listOpenBitWindows(strings.TrimRight(*bitAPI, "/"), *pageSize, *timeout)
	if err != nil {
		log.Fatalf("list BitBrowser windows: %v", err)
	}

	doc := outputDocument{
		Format:      "chat2api-bitbrowser-credentials",
		Version:     1,
		GeneratedAt: time.Now().Format(time.RFC3339),
		BitAPI:      strings.TrimRight(*bitAPI, "/"),
	}
	for _, win := range windows {
		doc.Windows = append(doc.Windows, collectWindowCredentials(win, *includeRaw, *timeout))
	}

	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		log.Fatalf("marshal output: %v", err)
	}
	data = append(data, '\n')
	outputPath := *outFile
	if outputPath == "" {
		outputPath = "bitbrowser-credentials-" + time.Now().Format("20060102-150405") + ".json"
	}
	if outputPath != "-" {
		if err := os.WriteFile(outputPath, data, 0o600); err != nil {
			log.Fatalf("write output: %v", err)
		}
		fmt.Fprintf(os.Stderr, "Wrote %s\n", outputPath)
		return
	}
	os.Stdout.Write(data)
}

func listOpenBitWindows(bitAPI string, pageSize int, timeout time.Duration) ([]bitWindow, error) {
	var all []bitWindow
	for page := 0; page < 100; page++ {
		body := map[string]any{"page": page, "pageSize": pageSize}
		var resp map[string]any
		if err := postJSON(bitAPI+"/browser/list", body, &resp, timeout); err != nil {
			if page == 0 {
				return nil, err
			}
			break
		}
		items := extractList(resp)
		if len(items) == 0 {
			break
		}
		for _, item := range items {
			win := normalizeBitWindow(item)
			if isOpenWindow(win) {
				if win.DebugAddress == "" && win.ID != "" {
					win.DebugAddress = fetchOpenDebugAddress(bitAPI, win.ID, timeout)
				}
				all = append(all, win)
			}
		}
		if len(items) < pageSize {
			break
		}
	}
	return all, nil
}

func importCredentials(inputPath string, storePath string, dryRun bool) error {
	data, err := os.ReadFile(inputPath)
	if err != nil {
		return err
	}
	var doc outputDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("read credential file: %w", err)
	}
	if doc.Format != "" && doc.Format != "chat2api-bitbrowser-credentials" {
		return fmt.Errorf("unsupported credential file format %q", doc.Format)
	}

	store := map[string]any{}
	if existing, err := os.ReadFile(storePath); err == nil && len(bytes.TrimSpace(existing)) > 0 {
		if err := json.Unmarshal(existing, &store); err != nil {
			return fmt.Errorf("read %s: %w", storePath, err)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}

	accounts := readAccountItems(store["accounts"])
	existingByKey := map[string]int{}
	for index, account := range accounts {
		providerID := mapStringField(account, "providerId")
		credentials := credentialsFromAny(account["credentials"])
		if providerID == "" || len(credentials) == 0 {
			continue
		}
		existingByKey[providerID+":"+credentialFingerprint(credentials)] = index
	}

	now := time.Now().UnixMilli()
	added := 0
	updated := 0
	for _, win := range doc.Windows {
		for _, provider := range win.Providers {
			credentials := cleanCredentials(provider.Credentials)
			if len(credentials) == 0 || !hasRequiredCredential(provider.Provider, credentials) {
				continue
			}
			key := provider.Provider + ":" + credentialFingerprint(credentials)
			name := accountName(provider, win)
			if index, ok := existingByKey[key]; ok {
				accounts[index]["name"] = name
				accounts[index]["credentials"] = credentials
				accounts[index]["status"] = "active"
				accounts[index]["updatedAt"] = now
				delete(accounts[index], "errorMessage")
				updated++
				continue
			}

			account := map[string]any{
				"id":          createAccountID(now, provider.Provider, added),
				"providerId":  provider.Provider,
				"name":        name,
				"credentials": credentials,
				"status":      "active",
				"createdAt":   now,
				"updatedAt":   now,
				"proxyMode":   "none",
			}
			accounts = append(accounts, account)
			existingByKey[key] = len(accounts) - 1
			added++
		}
	}

	store["accounts"] = accounts
	if dryRun {
		fmt.Fprintf(os.Stderr, "Dry run: would add %d account(s), update %d account(s) in %s\n", added, updated, storePath)
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(storePath), 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(storePath); err == nil {
		backupPath := storePath + ".bak-" + time.Now().Format("20060102-150405")
		if err := copyFile(storePath, backupPath); err != nil {
			return fmt.Errorf("backup data.json: %w", err)
		}
		fmt.Fprintf(os.Stderr, "Backed up %s\n", backupPath)
	}

	out, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	if err := os.WriteFile(storePath, out, 0o600); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Imported credentials: added %d account(s), updated %d account(s) in %s\n", added, updated, storePath)
	return nil
}

func resolveStorePath(value string) string {
	if strings.TrimSpace(value) != "" {
		return expandHome(value)
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".chat2api", "data.json")
	}
	return filepath.Join(home, ".chat2api", "data.json")
}

func expandHome(path string) string {
	if path == "~" {
		home, _ := os.UserHomeDir()
		return home
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, path[2:])
	}
	return path
}

func readAccountItems(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	accounts := make([]map[string]any, 0, len(items))
	for _, item := range items {
		account, ok := item.(map[string]any)
		if ok {
			accounts = append(accounts, account)
		}
	}
	return accounts
}

func mapStringField(m map[string]any, key string) string {
	value, _ := m[key].(string)
	return strings.TrimSpace(value)
}

func credentialsFromAny(value any) map[string]string {
	out := map[string]string{}
	switch typed := value.(type) {
	case map[string]string:
		for key, raw := range typed {
			if raw = strings.TrimSpace(raw); raw != "" {
				out[key] = raw
			}
		}
	case map[string]any:
		for key, raw := range typed {
			switch v := raw.(type) {
			case string:
				if v = strings.TrimSpace(v); v != "" {
					out[key] = v
				}
			case float64:
				if v != 0 {
					out[key] = strconv.FormatInt(int64(v), 10)
				}
			case bool:
				out[key] = strconv.FormatBool(v)
			}
		}
	}
	return out
}

func cleanCredentials(credentials map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range credentials {
		value = strings.TrimSpace(value)
		if value != "" {
			out[key] = value
		}
	}
	return out
}

func hasRequiredCredential(providerID string, credentials map[string]string) bool {
	switch providerID {
	case "deepseek", "kimi", "zai", "qwen-ai":
		return credentials["token"] != ""
	case "doubao":
		return credentials["sessionid"] != "" || credentials["cookie"] != ""
	case "yuanbao":
		return credentials["cookie"] != ""
	case "glm":
		return credentials["refresh_token"] != ""
	case "qwen":
		return credentials["ticket"] != "" || credentials["cookie"] != ""
	case "minimax":
		return credentials["token"] != ""
	case "mimo":
		return credentials["service_token"] != "" && credentials["user_id"] != "" && credentials["ph_token"] != ""
	case "perplexity":
		return credentials["sessionToken"] != "" || credentials["cookie"] != ""
	default:
		return len(credentials) > 0
	}
}

func accountName(provider providerResult, win windowResult) string {
	parts := []string{provider.Name}
	if win.Name != "" {
		parts = append(parts, win.Name)
	} else if win.WindowID != "" {
		parts = append(parts, win.WindowID)
	}
	return strings.Join(parts, " - ")
}

func credentialFingerprint(credentials map[string]string) string {
	keys := make([]string, 0, len(credentials))
	for key := range credentials {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	h := sha256.New()
	for _, key := range keys {
		h.Write([]byte(key))
		h.Write([]byte{0})
		h.Write([]byte(credentials[key]))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func createAccountID(now int64, providerID string, offset int) string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%d:%s:%d", now, providerID, offset)))
	return fmt.Sprintf("%d-%s", now+int64(offset), hex.EncodeToString(h[:])[:8])
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func collectWindowCredentials(win bitWindow, includeRaw bool, timeout time.Duration) windowResult {
	result := windowResult{WindowID: win.ID, Name: win.Name, Status: win.Status, DebugAddress: win.DebugAddress}
	debugURL, err := normalizeDebugURL(win.DebugAddress)
	if err != nil {
		result.Error = err.Error()
		return result
	}

	wsURL, err := discoverWebSocketURL(debugURL, timeout)
	if err != nil {
		result.Error = err.Error()
		return result
	}

	cdp, err := dialCDP(wsURL, timeout)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer cdp.Close()

	cookies, err := cdp.getCookies()
	if err != nil {
		result.Error = "read cookies: " + err.Error()
		return result
	}
	storages, err := cdp.getPageStorages()
	if err != nil {
		result.Error = "read storage: " + err.Error()
		return result
	}

	pageURLs := make([]string, 0, len(storages))
	for _, storage := range storages {
		pageURLs = append(pageURLs, storage.URL)
	}
	sort.Strings(pageURLs)
	result.PageURLs = pageURLs

	for _, spec := range providerSpecs {
		if !windowHasProviderData(spec, cookies, storages) {
			continue
		}
		result.Providers = append(result.Providers, buildProviderResult(spec, cookies, storages))
	}

	if includeRaw {
		localRaw := map[string]map[string]string{}
		sessionRaw := map[string]map[string]string{}
		for _, storage := range storages {
			if len(storage.LocalStorage) > 0 {
				localRaw[storage.Origin] = storage.LocalStorage
			}
			if len(storage.SessionStorage) > 0 {
				sessionRaw[storage.Origin] = storage.SessionStorage
			}
		}
		result.Raw = &rawCredentialSnapshot{Cookies: cookies, LocalStorage: localRaw, SessionStorage: sessionRaw}
	}

	return result
}

func buildProviderResult(spec providerSpec, cookies []cdpCookie, storages []pageStorage) providerResult {
	cookieMap := collectCookieMap(spec, cookies)
	localMap, sessionMap := collectStorageMaps(spec, storages)
	credentials := map[string]string{}

	for outKey, candidates := range spec.CookieFields {
		credentials[outKey] = pickMapValue(cookieMap, candidates)
	}
	for outKey, candidates := range spec.LocalFields {
		if credentials[outKey] == "" {
			credentials[outKey] = pickMapValue(localMap, candidates)
		}
	}
	for outKey, candidates := range spec.SessionFields {
		if credentials[outKey] == "" {
			credentials[outKey] = pickMapValue(sessionMap, candidates)
		}
	}
	if spec.NeedsCookieHeader && len(cookieMap) > 0 {
		credentials["cookie"] = buildCookieHeader(cookieMap)
	}

	provider := providerResult{Provider: spec.ID, Name: spec.Name, Credentials: credentials}
	if spec.Extra != nil {
		spec.Extra(&provider, cookieMap, localMap, sessionMap)
	}
	keys := credentialKeysForSpec(spec)
	for _, key := range keys {
		if strings.TrimSpace(provider.Credentials[key]) != "" {
			provider.Found = append(provider.Found, key)
		} else {
			provider.Missing = append(provider.Missing, key)
		}
	}
	sort.Strings(provider.Found)
	sort.Strings(provider.Missing)
	return provider
}

func credentialKeysForSpec(spec providerSpec) []string {
	set := map[string]bool{}
	for key := range spec.CookieFields { set[key] = true }
	for key := range spec.LocalFields { set[key] = true }
	for key := range spec.SessionFields { set[key] = true }
	if spec.NeedsCookieHeader { set["cookie"] = true }
	if spec.ID == "doubao" { set["fp"] = true }
	keys := make([]string, 0, len(set))
	for key := range set { keys = append(keys, key) }
	sort.Strings(keys)
	return keys
}

func windowHasProviderData(spec providerSpec, cookies []cdpCookie, storages []pageStorage) bool {
	for _, cookie := range cookies {
		if hostMatches(cookie.Domain, spec.Hosts) {
			return true
		}
	}
	for _, storage := range storages {
		if u, err := url.Parse(storage.URL); err == nil && hostMatches(u.Hostname(), spec.Hosts) {
			return true
		}
	}
	return false
}

func collectCookieMap(spec providerSpec, cookies []cdpCookie) map[string]string {
	out := map[string]string{}
	for _, cookie := range cookies {
		if hostMatches(cookie.Domain, spec.Hosts) && cookie.Value != "" {
			out[cookie.Name] = cookie.Value
		}
	}
	return out
}

func collectStorageMaps(spec providerSpec, storages []pageStorage) (map[string]string, map[string]string) {
	localOut := map[string]string{}
	sessionOut := map[string]string{}
	for _, storage := range storages {
		u, err := url.Parse(storage.URL)
		if err != nil || !hostMatches(u.Hostname(), spec.Hosts) {
			continue
		}
		for k, v := range storage.LocalStorage {
			if v != "" { localOut[k] = v }
		}
		for k, v := range storage.SessionStorage {
			if v != "" { sessionOut[k] = v }
		}
	}
	return localOut, sessionOut
}

func postJSON(endpoint string, body any, out any, timeout time.Duration) error {
	data, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil { return err }
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%s returned HTTP %d: %s", endpoint, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func getJSON(endpoint string, out any, timeout time.Duration) error {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(endpoint)
	if err != nil { return err }
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s returned HTTP %d", endpoint, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func extractList(value any) []map[string]any {
	var walk func(any) []map[string]any
	walk = func(v any) []map[string]any {
		switch typed := v.(type) {
		case []any:
			items := make([]map[string]any, 0, len(typed))
			for _, item := range typed {
				if m, ok := item.(map[string]any); ok {
					items = append(items, m)
				}
			}
			return items
		case map[string]any:
			for _, key := range []string{"list", "items", "data", "rows"} {
				if got := walk(typed[key]); len(got) > 0 {
					return got
				}
			}
		}
		return nil
	}
	return walk(value)
}

func normalizeBitWindow(raw map[string]any) bitWindow {
	return bitWindow{
		Raw: raw,
		ID: firstNonEmpty(pickString(raw, "id", "browserId", "browser_id", "userId", "seq")),
		Name: firstNonEmpty(pickString(raw, "name", "browserName", "browser_name", "remark", "title")),
		Status: firstNonEmpty(pickString(raw, "status", "state", "browserStatus", "openStatus", "isOpen")),
		DebugAddress: firstNonEmpty(
			pickString(raw, "http", "debugAddress", "debug_address", "debuggingAddress", "remoteDebuggingAddress"),
			debugPortToAddress(pickString(raw, "debuggingPort", "remoteDebuggingPort", "debugPort", "port")),
			pickString(raw, "ws", "wsEndpoint", "webSocketDebuggerUrl"),
		),
	}
}

func isOpenWindow(win bitWindow) bool {
	if win.DebugAddress != "" {
		return true
	}
	status := strings.ToLower(strings.TrimSpace(win.Status))
	return status == "open" || status == "opened" || status == "running" || status == "active" || status == "1" || status == "true"
}

func fetchOpenDebugAddress(bitAPI string, windowID string, timeout time.Duration) string {
	for _, body := range []map[string]any{{"id": windowID}, {"browserId": windowID}, {"seq": windowID}} {
		var resp map[string]any
		if err := postJSON(bitAPI+"/browser/open", body, &resp, timeout); err != nil {
			continue
		}
		if addr := findDebugAddress(resp); addr != "" {
			return addr
		}
	}
	return ""
}

func findDebugAddress(value any) string {
	switch typed := value.(type) {
	case map[string]any:
		if addr := firstNonEmpty(
			pickString(typed, "http", "debugAddress", "debug_address", "debuggingAddress", "remoteDebuggingAddress"),
			debugPortToAddress(pickString(typed, "debuggingPort", "remoteDebuggingPort", "debugPort", "port")),
			pickString(typed, "ws", "wsEndpoint", "webSocketDebuggerUrl"),
		); addr != "" {
			return addr
		}
		for _, child := range typed {
			if addr := findDebugAddress(child); addr != "" {
				return addr
			}
		}
	case []any:
		for _, child := range typed {
			if addr := findDebugAddress(child); addr != "" {
				return addr
			}
		}
	}
	return ""
}

func normalizeDebugURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" { return "", errors.New("open window has no debug address from BitBrowser API") }
	if strings.HasPrefix(value, "ws://") || strings.HasPrefix(value, "wss://") {
		return value, nil
	}
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		value = "http://" + value
	}
	return strings.TrimRight(value, "/"), nil
}

func discoverWebSocketURL(debugURL string, timeout time.Duration) (string, error) {
	if strings.HasPrefix(debugURL, "ws://") || strings.HasPrefix(debugURL, "wss://") {
		return debugURL, nil
	}
	var version map[string]any
	if err := getJSON(debugURL+"/json/version", &version, timeout); err == nil {
		if ws := pickString(version, "webSocketDebuggerUrl"); ws != "" {
			return ws, nil
		}
	}
	var targets []map[string]any
	if err := getJSON(debugURL+"/json", &targets, timeout); err == nil {
		for _, target := range targets {
			if ws := pickString(target, "webSocketDebuggerUrl"); ws != "" {
				return ws, nil
			}
		}
	}
	return "", fmt.Errorf("cannot discover CDP websocket from %s", debugURL)
}

type cdpClient struct {
	conn net.Conn
	reader *bufio.Reader
	nextID int64
}

func dialCDP(wsURL string, timeout time.Duration) (*cdpClient, error) {
	u, err := url.Parse(wsURL)
	if err != nil { return nil, err }
	if u.Scheme != "ws" {
		return nil, fmt.Errorf("only ws:// CDP endpoints are supported by this stdlib script: %s", wsURL)
	}
	conn, err := net.DialTimeout("tcp", u.Host, timeout)
	if err != nil { return nil, err }
	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil { conn.Close(); return nil, err }
	key := base64.StdEncoding.EncodeToString(keyBytes)
	path := u.RequestURI()
	if path == "" { path = "/" }
	fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", path, u.Host, key)
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n')
	if err != nil { conn.Close(); return nil, err }
	if !strings.Contains(status, " 101 ") {
		conn.Close()
		return nil, fmt.Errorf("websocket handshake failed: %s", strings.TrimSpace(status))
	}
	acceptWant := computeWebSocketAccept(key)
	acceptGot := ""
	for {
		line, err := reader.ReadString('\n')
		if err != nil { conn.Close(); return nil, err }
		line = strings.TrimSpace(line)
		if line == "" { break }
		parts := strings.SplitN(line, ":", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "Sec-WebSocket-Accept") {
			acceptGot = strings.TrimSpace(parts[1])
		}
	}
	if acceptGot != "" && acceptGot != acceptWant {
		conn.Close()
		return nil, errors.New("websocket accept key mismatch")
	}
	return &cdpClient{conn: conn, reader: reader}, nil
}

func (c *cdpClient) Close() error { return c.conn.Close() }

func (c *cdpClient) call(method string, params any, sessionID string) (map[string]any, error) {
	id := atomic.AddInt64(&c.nextID, 1)
	msg := map[string]any{"id": id, "method": method}
	if params != nil { msg["params"] = params }
	if sessionID != "" { msg["sessionId"] = sessionID }
	data, _ := json.Marshal(msg)
	if err := c.writeText(data); err != nil { return nil, err }
	for {
		payload, err := c.readText()
		if err != nil { return nil, err }
		var resp map[string]any
		if err := json.Unmarshal(payload, &resp); err != nil { continue }
		if int64(asFloat(resp["id"])) != id { continue }
		if errVal, ok := resp["error"].(map[string]any); ok {
			return nil, fmt.Errorf("CDP %s error: %v", method, errVal)
		}
		return resp, nil
	}
}

func (c *cdpClient) getCookies() ([]cdpCookie, error) {
	resp, err := c.call("Storage.getCookies", map[string]any{}, "")
	if err != nil {
		resp, err = c.call("Network.getAllCookies", map[string]any{}, "")
		if err != nil { return nil, err }
	}
	result, _ := resp["result"].(map[string]any)
	items, _ := result["cookies"].([]any)
	cookies := make([]cdpCookie, 0, len(items))
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok { continue }
		cookies = append(cookies, cdpCookie{
			Name: pickString(m, "name"), Value: pickString(m, "value"), Domain: pickString(m, "domain"), Path: pickString(m, "path"),
			Expires: asFloat(m["expires"]), HTTPOnly: asBool(m["httpOnly"]), Secure: asBool(m["secure"]),
		})
	}
	return cookies, nil
}

func (c *cdpClient) getPageStorages() ([]pageStorage, error) {
	resp, err := c.call("Target.getTargets", map[string]any{}, "")
	if err != nil { return nil, err }
	result, _ := resp["result"].(map[string]any)
	infos, _ := result["targetInfos"].([]any)
	out := []pageStorage{}
	for _, infoRaw := range infos {
		info, ok := infoRaw.(map[string]any)
		if !ok || pickString(info, "type") != "page" { continue }
		targetID := pickString(info, "targetId")
		pageURL := pickString(info, "url")
		if targetID == "" || pageURL == "" || strings.HasPrefix(pageURL, "chrome") { continue }
		attach, err := c.call("Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, "")
		if err != nil { continue }
		attachResult, _ := attach["result"].(map[string]any)
		sessionID := pickString(attachResult, "sessionId")
		if sessionID == "" { continue }
		storage, err := c.evaluateStorage(sessionID)
		if err == nil { out = append(out, storage) }
		_, _ = c.call("Target.detachFromTarget", map[string]any{"sessionId": sessionID}, "")
	}
	return out, nil
}

func (c *cdpClient) evaluateStorage(sessionID string) (pageStorage, error) {
	expression := `(() => {
  const copy = s => { const out = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); out[k] = s.getItem(k); } return out; };
  return { url: location.href, origin: location.origin, localStorage: copy(localStorage), sessionStorage: copy(sessionStorage) };
})()`
	resp, err := c.call("Runtime.evaluate", map[string]any{"expression": expression, "returnByValue": true, "awaitPromise": true}, sessionID)
	if err != nil { return pageStorage{}, err }
	result, _ := resp["result"].(map[string]any)
	remote, _ := result["result"].(map[string]any)
	value, _ := remote["value"].(map[string]any)
	return pageStorage{
		URL: pickString(value, "url"), Origin: pickString(value, "origin"),
		LocalStorage: stringMap(value["localStorage"]), SessionStorage: stringMap(value["sessionStorage"]),
	}, nil
}

func (c *cdpClient) writeText(payload []byte) error {
	var frame bytes.Buffer
	frame.WriteByte(0x81)
	length := len(payload)
	switch {
	case length < 126:
		frame.WriteByte(byte(0x80 | length))
	case length <= math.MaxUint16:
		frame.WriteByte(0x80 | 126)
		binary.Write(&frame, binary.BigEndian, uint16(length))
	default:
		frame.WriteByte(0x80 | 127)
		binary.Write(&frame, binary.BigEndian, uint64(length))
	}
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil { return err }
	frame.Write(mask)
	for i, b := range payload { frame.WriteByte(b ^ mask[i%4]) }
	_, err := c.conn.Write(frame.Bytes())
	return err
}

func (c *cdpClient) readText() ([]byte, error) {
	for {
		header := make([]byte, 2)
		if _, err := io.ReadFull(c.reader, header); err != nil { return nil, err }
		opcode := header[0] & 0x0f
		masked := header[1]&0x80 != 0
		length := uint64(header[1] & 0x7f)
		if length == 126 {
			var v uint16
			if err := binary.Read(c.reader, binary.BigEndian, &v); err != nil { return nil, err }
			length = uint64(v)
		} else if length == 127 {
			if err := binary.Read(c.reader, binary.BigEndian, &length); err != nil { return nil, err }
		}
		mask := []byte{0,0,0,0}
		if masked { if _, err := io.ReadFull(c.reader, mask); err != nil { return nil, err } }
		payload := make([]byte, length)
		if _, err := io.ReadFull(c.reader, payload); err != nil { return nil, err }
		if masked { for i := range payload { payload[i] ^= mask[i%4] } }
		switch opcode {
		case 0x1:
			return payload, nil
		case 0x8:
			return nil, io.EOF
		case 0x9:
			_ = c.writeControl(0xA, payload)
		}
	}
}

func (c *cdpClient) writeControl(opcode byte, payload []byte) error {
	if len(payload) > 125 { payload = payload[:125] }
	var frame bytes.Buffer
	frame.WriteByte(0x80 | opcode)
	frame.WriteByte(0x80 | byte(len(payload)))
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil { return err }
	frame.Write(mask)
	for i, b := range payload { frame.WriteByte(b ^ mask[i%4]) }
	_, err := c.conn.Write(frame.Bytes())
	return err
}

func computeWebSocketAccept(key string) string {
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h[:])
}

func pickString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		switch v := m[key].(type) {
		case string:
			if strings.TrimSpace(v) != "" { return strings.TrimSpace(v) }
		case float64:
			if v != 0 { return strconv.FormatInt(int64(v), 10) }
		case bool:
			return strconv.FormatBool(v)
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" { return strings.TrimSpace(value) }
	}
	return ""
}

func pickMapValue(m map[string]string, keys []string) string {
	for _, key := range keys {
		if v := strings.TrimSpace(m[key]); v != "" { return v }
	}
	return ""
}

func buildCookieHeader(cookies map[string]string) string {
	keys := make([]string, 0, len(cookies))
	for key := range cookies { keys = append(keys, key) }
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys { parts = append(parts, key+"="+cookies[key]) }
	return strings.Join(parts, "; ")
}

func hostMatches(host string, patterns []string) bool {
	host = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(host)), ".")
	for _, pattern := range patterns {
		pattern = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(pattern)), ".")
		if host == pattern || strings.HasSuffix(host, "."+pattern) { return true }
	}
	return false
}

func debugPortToAddress(value string) string {
	if value == "" || strings.Contains(value, ":") { return value }
	if _, err := strconv.Atoi(value); err == nil { return "127.0.0.1:" + value }
	return ""
}

func stringMap(value any) map[string]string {
	out := map[string]string{}
	if m, ok := value.(map[string]any); ok {
		for key, raw := range m {
			if s, ok := raw.(string); ok { out[key] = s }
		}
	}
	return out
}

func asFloat(value any) float64 {
	switch v := value.(type) {
	case float64: return v
	case int: return float64(v)
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	}
	return 0
}

func asBool(value any) bool {
	switch v := value.(type) {
	case bool: return v
	case string: return v == "true" || v == "1"
	case float64: return v != 0
	}
	return false
}

func findVerifyToken(values map[string]string) string {
	re := regexp.MustCompile(`verify_[A-Za-z0-9_-]+`)
	for _, value := range values {
		if match := re.FindString(value); match != "" { return match }
	}
	return ""
}

func parseRealUserID(value string) string {
	if value == "" { return "" }
	var parsed map[string]any
	if err := json.Unmarshal([]byte(value), &parsed); err != nil { return "" }
	return firstNonEmpty(pickString(parsed, "realUserID", "real_user_id", "userId", "id"))
}
