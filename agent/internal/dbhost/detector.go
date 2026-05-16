package dbhost

// Detected agrupa los datos descubiertos al arrancar: motor, PID del proceso
// principal, datadir y log path. Cualquier valor configurado explicitamente
// por flag debe pisar al detectado.
type Detected struct {
	Engine        string // postgres | mysql | mongo
	EngineVersion string
	PID           int    // PID del proceso principal del motor (postmaster, mysqld, mongod)
	DataDir       string // path absoluto del datadir
	LogPath       string // path al log principal (si se encuentra)
}

// Detect descubre el motor de BD que corre en este host. Implementacion
// platform-specific. En no-Linux devuelve Engine vacio (no soportado).
func Detect(hint string) (Detected, error) {
	return detect(hint)
}
