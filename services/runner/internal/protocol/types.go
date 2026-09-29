// Package protocol defines the DeployForge runner protocol, version 1.
//
// The TypeScript definition lives in packages/contracts/src/runner-protocol.ts.
// Both sides are tested against the JSON fixtures in
// packages/contracts/fixtures/runner-v1 so that drift fails CI.
package protocol

const Version = 1

const (
	HeaderProtocol  = "X-Deployforge-Protocol"
	HeaderTimestamp = "X-Deployforge-Timestamp"
	HeaderNonce     = "X-Deployforge-Nonce"
	HeaderSignature = "X-Deployforge-Signature"
)

// Ownership labels. The runner only mutates or deletes Docker objects that
// carry LabelManaged=true AND LabelInstance equal to its own instance ID, so
// several installations (for example a dev and a test stack) can share one
// Docker daemon without touching each other's resources.
const (
	LabelManaged     = "io.deployforge.managed"
	LabelWorkspace   = "io.deployforge.workspace"
	LabelApplication = "io.deployforge.application"
	LabelDeployment  = "io.deployforge.deployment"
	LabelRole        = "io.deployforge.role"
	LabelInstance    = "io.deployforge.instance"
)

type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type ComponentStatus struct {
	OK      bool   `json:"ok"`
	Version string `json:"version,omitempty"`
	Error   string `json:"error,omitempty"`
}

type Health struct {
	OK                  bool            `json:"ok"`
	ProtocolVersion     int             `json:"protocolVersion"`
	RunnerVersion       string          `json:"runnerVersion"`
	Docker              ComponentStatus `json:"docker"`
	Buildx              ComponentStatus `json:"buildx"`
	ActiveBuilds        int             `json:"activeBuilds"`
	MaxConcurrentBuilds int             `json:"maxConcurrentBuilds"`
}

type RepoAuth struct {
	Username string `json:"username"`
	Token    string `json:"token"`
}

type Repository struct {
	CloneURL  string    `json:"cloneUrl"`
	CommitSHA string    `json:"commitSha"`
	Auth      *RepoAuth `json:"auth,omitempty"`
}

type BuildSecret struct {
	ID    string `json:"id"`
	Value string `json:"value"`
}

type BuildRequest struct {
	OperationID    string            `json:"operationId"`
	WorkspaceID    string            `json:"workspaceId"`
	ApplicationID  string            `json:"applicationId"`
	DeploymentID   string            `json:"deploymentId"`
	Repository     Repository        `json:"repository"`
	ContextDir     string            `json:"contextDir"`
	DockerfilePath string            `json:"dockerfilePath"`
	BuildArgs      map[string]string `json:"buildArgs"`
	BuildSecrets   []BuildSecret     `json:"buildSecrets"`
	ImageTag       string            `json:"imageTag"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
	Redact         []string          `json:"redact"`
}

type LogLine struct {
	Seq    int64  `json:"seq"`
	TS     string `json:"ts"`
	Stream string `json:"stream"`
	Text   string `json:"text"`
}

type BuildStatus struct {
	OperationID   string    `json:"operationId"`
	State         string    `json:"state"`
	Phase         string    `json:"phase"`
	CommitSHA     string    `json:"commitSha,omitempty"`
	CommitMessage string    `json:"commitMessage,omitempty"`
	ImageID       string    `json:"imageId,omitempty"`
	Error         *Error    `json:"error,omitempty"`
	FailureKind   string    `json:"failureKind,omitempty"`
	Logs          []LogLine `json:"logs"`
	NextSeq       int64     `json:"nextSeq"`
	LogsTruncated bool      `json:"logsTruncated"`
}

type ContainerCreateRequest struct {
	OperationID     string            `json:"operationId"`
	WorkspaceID     string            `json:"workspaceId"`
	ApplicationID   string            `json:"applicationId"`
	DeploymentID    string            `json:"deploymentId"`
	Name            string            `json:"name"`
	Image           string            `json:"image"`
	Env             map[string]string `json:"env"`
	Port            int               `json:"port"`
	CPULimit        float64           `json:"cpuLimit"`
	MemoryLimitMB   int64             `json:"memoryLimitMb"`
	PidsLimit       int64             `json:"pidsLimit"`
	SecurityProfile string            `json:"securityProfile"`
	Network         string            `json:"network"`
}

type ContainerSummary struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Image        string            `json:"image"`
	State        string            `json:"state"`
	Running      bool              `json:"running"`
	ExitCode     int               `json:"exitCode"`
	OOMKilled    bool              `json:"oomKilled"`
	RestartCount int               `json:"restartCount"`
	StartedAt    string            `json:"startedAt,omitempty"`
	FinishedAt   string            `json:"finishedAt,omitempty"`
	IPAddress    string            `json:"ipAddress,omitempty"`
	Labels       map[string]string `json:"labels"`
}

type ContainerCreateResponse struct {
	Created   bool             `json:"created"`
	Container ContainerSummary `json:"container"`
}

type ProbeRequest struct {
	Port      int    `json:"port"`
	Path      string `json:"path"`
	TimeoutMs int    `json:"timeoutMs"`
}

type ProbeResult struct {
	OK         bool             `json:"ok"`
	StatusCode int              `json:"statusCode,omitempty"`
	Error      string           `json:"error,omitempty"`
	DurationMs int64            `json:"durationMs"`
	Container  ContainerSummary `json:"container"`
}

type ContainerStats struct {
	SampledAt        string  `json:"sampledAt"`
	CPUPercent       float64 `json:"cpuPercent"`
	OnlineCPUs       int     `json:"onlineCpus"`
	MemoryBytes      float64 `json:"memoryBytes"`
	MemoryLimitBytes float64 `json:"memoryLimitBytes"`
	Pids             int     `json:"pids"`
	Running          bool    `json:"running"`
	RestartCount     int     `json:"restartCount"`
	StartedAt        string  `json:"startedAt,omitempty"`
}

type NetworkEnsureRequest struct {
	WorkspaceID   string `json:"workspaceId"`
	ApplicationID string `json:"applicationId"`
}

type NetworkEnsureResponse struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

type StopRequest struct {
	TimeoutSeconds int `json:"timeoutSeconds"`
}

type GitResolveRequest struct {
	CloneURL string    `json:"cloneUrl"`
	Branch   string    `json:"branch"`
	Auth     *RepoAuth `json:"auth,omitempty"`
}

type GitResolveResponse struct {
	CommitSHA string `json:"commitSha"`
	Found     bool   `json:"found"`
}

type ImageSummary struct {
	ID        string            `json:"id"`
	Tags      []string          `json:"tags"`
	SizeBytes int64             `json:"sizeBytes"`
	CreatedAt string            `json:"createdAt"`
	Labels    map[string]string `json:"labels"`
}
