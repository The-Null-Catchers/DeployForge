// Package docker is a small Docker Engine API client over the local unix
// socket. It covers only the endpoints DeployForge needs, which keeps the
// runner free of third-party dependencies.
package docker

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// MaxAPIVersion is the newest Engine API version this client was written
// against. The client negotiates down to the daemon's version if older.
const MaxAPIVersion = "1.51"

type Client struct {
	http    *http.Client
	stream  *http.Client
	version string
}

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("docker api %d: %s", e.Status, e.Message) }

func IsNotFound(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == http.StatusNotFound
}

func IsConflict(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == http.StatusConflict
}

func New(socketPath string) *Client {
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socketPath)
	}
	tr := &http.Transport{DialContext: dial, MaxIdleConns: 20, IdleConnTimeout: 30 * time.Second}
	return &Client{
		http:   &http.Client{Transport: tr, Timeout: 60 * time.Second},
		stream: &http.Client{Transport: tr},
	}
}

// Negotiate picks the API version to use from the daemon's /version.
func (c *Client) Negotiate(ctx context.Context) (Version, error) {
	var v Version
	if err := c.do(ctx, http.MethodGet, "/version", nil, nil, &v); err != nil {
		return v, err
	}
	c.version = MaxAPIVersion
	if versionLess(v.APIVersion, MaxAPIVersion) {
		c.version = v.APIVersion
	}
	return v, nil
}

func versionLess(a, b string) bool {
	var a1, a2, b1, b2 int
	fmt.Sscanf(a, "%d.%d", &a1, &a2)
	fmt.Sscanf(b, "%d.%d", &b1, &b2)
	return a1 < b1 || (a1 == b1 && a2 < b2)
}

func (c *Client) url(path string, q url.Values) string {
	u := "http://docker"
	if c.version != "" && path != "/version" {
		u += "/v" + c.version
	}
	u += path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	return u
}

func (c *Client) request(ctx context.Context, method, path string, q url.Values, body any) (*http.Request, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.url(path, q), rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

func (c *Client) do(ctx context.Context, method, path string, q url.Values, body, out any) error {
	req, err := c.request(ctx, method, path, q, body)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotModified {
		return readError(resp)
	}
	if out != nil && resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusNotModified {
		return json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(out)
	}
	return nil
}

func readError(resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var m struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(b, &m) != nil || m.Message == "" {
		m.Message = strings.TrimSpace(string(b))
	}
	return &APIError{Status: resp.StatusCode, Message: m.Message}
}

func labelFilter(labels ...string) url.Values {
	f, _ := json.Marshal(map[string][]string{"label": labels})
	return url.Values{"filters": {string(f)}}
}

// ---- types (subset of the Engine API) ----

type Version struct {
	Version    string `json:"Version"`
	APIVersion string `json:"ApiVersion"`
}

type RestartPolicy struct {
	Name              string `json:"Name"`
	MaximumRetryCount int    `json:"MaximumRetryCount,omitempty"`
}

type LogConfig struct {
	Type   string            `json:"Type"`
	Config map[string]string `json:"Config,omitempty"`
}

type HostConfig struct {
	NanoCPUs       int64          `json:"NanoCpus,omitempty"`
	Memory         int64          `json:"Memory,omitempty"`
	MemorySwap     int64          `json:"MemorySwap,omitempty"`
	PidsLimit      *int64         `json:"PidsLimit,omitempty"`
	CapDrop        []string       `json:"CapDrop,omitempty"`
	SecurityOpt    []string       `json:"SecurityOpt,omitempty"`
	Privileged     bool           `json:"Privileged"`
	NetworkMode    string         `json:"NetworkMode,omitempty"`
	RestartPolicy  RestartPolicy  `json:"RestartPolicy"`
	LogConfig      LogConfig      `json:"LogConfig"`
	ReadonlyRootfs bool           `json:"ReadonlyRootfs"`
	Binds          []string       `json:"Binds"`
	PortBindings   map[string]any `json:"PortBindings"`
}

type EndpointSettings struct {
	Aliases   []string `json:"Aliases,omitempty"`
	IPAddress string   `json:"IPAddress,omitempty"`
	NetworkID string   `json:"NetworkID,omitempty"`
}

type ContainerConfig struct {
	Hostname         string              `json:"Hostname,omitempty"`
	Image            string              `json:"Image"`
	Env              []string            `json:"Env,omitempty"`
	Labels           map[string]string   `json:"Labels,omitempty"`
	ExposedPorts     map[string]struct{} `json:"ExposedPorts,omitempty"`
	HostConfig       HostConfig          `json:"HostConfig"`
	NetworkingConfig *struct {
		EndpointsConfig map[string]EndpointSettings `json:"EndpointsConfig"`
	} `json:"NetworkingConfig,omitempty"`
}

type ContainerJSON struct {
	ID           string `json:"Id"`
	Name         string `json:"Name"`
	Image        string `json:"Image"`
	RestartCount int    `json:"RestartCount"`
	State        struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		ExitCode   int    `json:"ExitCode"`
		OOMKilled  bool   `json:"OOMKilled"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
	} `json:"State"`
	Config struct {
		Labels map[string]string `json:"Labels"`
		Image  string            `json:"Image"`
	} `json:"Config"`
	HostConfig struct {
		NanoCPUs int64 `json:"NanoCpus"`
		Memory   int64 `json:"Memory"`
	} `json:"HostConfig"`
	NetworkSettings struct {
		Networks map[string]EndpointSettings `json:"Networks"`
	} `json:"NetworkSettings"`
}

type ContainerListItem struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	Image  string            `json:"Image"`
	State  string            `json:"State"`
	Labels map[string]string `json:"Labels"`
}

type ImageListItem struct {
	ID       string            `json:"Id"`
	RepoTags []string          `json:"RepoTags"`
	Size     int64             `json:"Size"`
	Created  int64             `json:"Created"`
	Labels   map[string]string `json:"Labels"`
}

type ImageInspect struct {
	ID     string `json:"Id"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	RepoTags []string `json:"RepoTags"`
}

type Network struct {
	ID         string            `json:"Id"`
	Name       string            `json:"Name"`
	Labels     map[string]string `json:"Labels"`
	Containers map[string]struct {
		Name string `json:"Name"`
	} `json:"Containers"`
}

type Stats struct {
	Read     string `json:"read"`
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	PidsStats struct {
		Current int `json:"current"`
	} `json:"pids_stats"`
}

// ---- endpoints ----

func (c *Client) Ping(ctx context.Context) error {
	return c.do(ctx, http.MethodGet, "/_ping", nil, nil, nil)
}

func (c *Client) CreateContainer(ctx context.Context, name string, cfg ContainerConfig) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, http.MethodPost, "/containers/create", url.Values{"name": {name}}, cfg, &out)
	return out.ID, err
}

func (c *Client) StartContainer(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil, nil, nil)
}

func (c *Client) StopContainer(ctx context.Context, id string, timeoutSeconds int) error {
	q := url.Values{"t": {fmt.Sprint(timeoutSeconds)}}
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/stop", q, nil, nil)
}

func (c *Client) RestartContainer(ctx context.Context, id string, timeoutSeconds int) error {
	q := url.Values{"t": {fmt.Sprint(timeoutSeconds)}}
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/restart", q, nil, nil)
}

func (c *Client) RemoveContainer(ctx context.Context, id string) error {
	q := url.Values{"force": {"true"}, "v": {"true"}}
	return c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(id), q, nil, nil)
}

func (c *Client) UpdateRestartPolicy(ctx context.Context, id string, p RestartPolicy) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/update", nil, map[string]any{"RestartPolicy": p}, nil)
}

func (c *Client) InspectContainer(ctx context.Context, id string) (*ContainerJSON, error) {
	var out ContainerJSON
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/json", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ListContainers(ctx context.Context, labels ...string) ([]ContainerListItem, error) {
	q := labelFilter(labels...)
	q.Set("all", "true")
	var out []ContainerListItem
	err := c.do(ctx, http.MethodGet, "/containers/json", q, nil, &out)
	return out, err
}

func (c *Client) Stats(ctx context.Context, id string) (*Stats, error) {
	var out Stats
	q := url.Values{"stream": {"false"}}
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/stats", q, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// LogFrame is a demultiplexed log frame from a non-TTY container.
type LogFrame struct {
	Stream string // stdout or stderr
	Data   []byte
}

// Logs streams container logs, calling fn for each demultiplexed frame.
func (c *Client) Logs(ctx context.Context, id string, follow bool, tail string, since int64, fn func(LogFrame) error) error {
	q := url.Values{"stdout": {"true"}, "stderr": {"true"}, "timestamps": {"true"}}
	if follow {
		q.Set("follow", "true")
	}
	if tail != "" {
		q.Set("tail", tail)
	}
	if since > 0 {
		q.Set("since", fmt.Sprint(since))
	}
	req, err := c.request(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/logs", q, nil)
	if err != nil {
		return err
	}
	resp, err := c.stream.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return readError(resp)
	}
	// DeployForge never allocates a TTY, so the stream is always multiplexed.
	return demux(resp.Body, fn)
}

func demux(r io.Reader, fn func(LogFrame) error) error {
	hdr := make([]byte, 8)
	for {
		if _, err := io.ReadFull(r, hdr); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return nil
			}
			return err
		}
		size := binary.BigEndian.Uint32(hdr[4:])
		if size > 16<<20 {
			return fmt.Errorf("log frame too large: %d", size)
		}
		buf := make([]byte, size)
		if _, err := io.ReadFull(r, buf); err != nil {
			return err
		}
		stream := "stdout"
		if hdr[0] == 2 {
			stream = "stderr"
		}
		if err := fn(LogFrame{Stream: stream, Data: buf}); err != nil {
			return err
		}
	}
}

func (c *Client) ListImages(ctx context.Context, labels ...string) ([]ImageListItem, error) {
	var out []ImageListItem
	err := c.do(ctx, http.MethodGet, "/images/json", labelFilter(labels...), nil, &out)
	return out, err
}

func (c *Client) InspectImage(ctx context.Context, ref string) (*ImageInspect, error) {
	var out ImageInspect
	if err := c.do(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) RemoveImage(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/images/"+url.PathEscape(id), nil, nil, nil)
}

func (c *Client) InspectNetwork(ctx context.Context, name string) (*Network, error) {
	var out Network
	if err := c.do(ctx, http.MethodGet, "/networks/"+url.PathEscape(name), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateNetwork(ctx context.Context, name string, labels map[string]string) (string, error) {
	body := map[string]any{
		"Name":           name,
		"Driver":         "bridge",
		"CheckDuplicate": true,
		"Labels":         labels,
		"Options": map[string]string{
			"com.docker.network.bridge.enable_icc": "true",
		},
	}
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, http.MethodPost, "/networks/create", nil, body, &out)
	return out.ID, err
}

func (c *Client) ConnectNetwork(ctx context.Context, network, container string) error {
	return c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/connect", nil, map[string]any{"Container": container}, nil)
}

func (c *Client) DisconnectNetwork(ctx context.Context, network, container string) error {
	return c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/disconnect", nil, map[string]any{"Container": container, "Force": true}, nil)
}

func (c *Client) RemoveNetwork(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/networks/"+url.PathEscape(id), nil, nil, nil)
}
