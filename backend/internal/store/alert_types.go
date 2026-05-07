package store

type alertValue struct {
	Metric      string
	ResourceKey string
	Value       float64
	Unit        string
	Label       string
}
