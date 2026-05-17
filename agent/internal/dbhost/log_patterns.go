package dbhost

import "regexp"

// LogPattern es un matcher para una linea de log. Una misma linea matchea
// al primer pattern que aplique (orden importa: poner los mas especificos
// primero, generales al final).
type LogPattern struct {
	Regex *regexp.Regexp
	Level string // FATAL | PANIC | ERROR | WARNING
	Key   string // identificador corto: deadlock, oom, archiver_failed, etc.
}

// patternsByEngine define los patterns relevantes por motor. Si el motor no
// esta en el map se cae a un set generico (solo niveles FATAL/ERROR/WARNING).
var patternsByEngine = map[string][]LogPattern{
	"postgres": {
		{Regex: regexp.MustCompile(`(?i)\bPANIC:\s+`), Level: "PANIC", Key: "panic"},
		{Regex: regexp.MustCompile(`(?i)out of memory`), Level: "FATAL", Key: "oom"},
		{Regex: regexp.MustCompile(`(?i)could not (open|extend|write|fsync)`), Level: "ERROR", Key: "io_failure"},
		{Regex: regexp.MustCompile(`(?i)deadlock detected`), Level: "ERROR", Key: "deadlock"},
		{Regex: regexp.MustCompile(`(?i)archiver.*failed|archive command failed`), Level: "ERROR", Key: "archiver_failed"},
		{Regex: regexp.MustCompile(`(?i)autovacuum.*(cancel|skip)`), Level: "WARNING", Key: "autovacuum_cancel"},
		{Regex: regexp.MustCompile(`(?i)checkpoints? are? occurring too frequently`), Level: "WARNING", Key: "checkpoint_frequent"},
		{Regex: regexp.MustCompile(`(?i)connection refused|too many connections`), Level: "ERROR", Key: "conn_refused"},
		{Regex: regexp.MustCompile(`(?i)server process .* was terminated by signal`), Level: "FATAL", Key: "backend_killed"},
		{Regex: regexp.MustCompile(`(?i)\bFATAL:\s+`), Level: "FATAL", Key: "fatal"},
		// Go RE2 no soporta lookahead; "duplicate key" se filtra en tailLog.
		{Regex: regexp.MustCompile(`(?i)\bERROR:\s+`), Level: "ERROR", Key: "error"},
	},
	"mysql": {
		{Regex: regexp.MustCompile(`(?i)\[ERROR\].*innodb.*cannot allocate`), Level: "FATAL", Key: "oom"},
		{Regex: regexp.MustCompile(`(?i)\[ERROR\].*innodb.*page corruption`), Level: "FATAL", Key: "corruption"},
		{Regex: regexp.MustCompile(`(?i)deadlock found`), Level: "ERROR", Key: "deadlock"},
		{Regex: regexp.MustCompile(`(?i)access denied for user`), Level: "WARNING", Key: "auth_failed"},
		{Regex: regexp.MustCompile(`(?i)slave|replica.*(stop|error|lag)`), Level: "WARNING", Key: "replica_issue"},
		{Regex: regexp.MustCompile(`(?i)aborted connection`), Level: "WARNING", Key: "conn_aborted"},
		{Regex: regexp.MustCompile(`(?i)\[ERROR\]`), Level: "ERROR", Key: "error"},
		{Regex: regexp.MustCompile(`(?i)\[Warning\]`), Level: "WARNING", Key: "warning"},
	},
	"mongo": {
		// Mongo desde 4.4 usa structured JSON logs
		{Regex: regexp.MustCompile(`"severity":\s*"F"`), Level: "FATAL", Key: "fatal"},
		{Regex: regexp.MustCompile(`"severity":\s*"E"`), Level: "ERROR", Key: "error"},
		{Regex: regexp.MustCompile(`(?i)out of memory|cannot allocate`), Level: "FATAL", Key: "oom"},
		{Regex: regexp.MustCompile(`(?i)wiredTiger.*error`), Level: "ERROR", Key: "wt_error"},
		{Regex: regexp.MustCompile(`(?i)replica.*(error|fatal)`), Level: "ERROR", Key: "replica_error"},
		{Regex: regexp.MustCompile(`(?i)election.*timeout|stepped down`), Level: "WARNING", Key: "election"},
		{Regex: regexp.MustCompile(`"severity":\s*"W"`), Level: "WARNING", Key: "warning"},
	},
}

// genericPatterns aplica cuando el motor no esta en patternsByEngine.
var genericPatterns = []LogPattern{
	{Regex: regexp.MustCompile(`(?i)\bPANIC\b`), Level: "PANIC", Key: "panic"},
	{Regex: regexp.MustCompile(`(?i)\bFATAL\b`), Level: "FATAL", Key: "fatal"},
	{Regex: regexp.MustCompile(`(?i)out of memory`), Level: "FATAL", Key: "oom"},
	{Regex: regexp.MustCompile(`(?i)\bERROR\b`), Level: "ERROR", Key: "error"},
	{Regex: regexp.MustCompile(`(?i)\bWARNING\b`), Level: "WARNING", Key: "warning"},
}

func patternsFor(engine string) []LogPattern {
	if p, ok := patternsByEngine[engine]; ok {
		return p
	}
	return genericPatterns
}
