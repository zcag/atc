package client

import (
	"fmt"
	"net/url"

	"github.com/zcag/atc/internal/ends"
	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/pages"
	"github.com/zcag/atc/internal/resources"
	"github.com/zcag/atc/internal/usage"
)

type Server struct {
	URL       string `json:"url"`
	Port      int    `json:"port"`
	LocalOnly bool   `json:"localOnly,omitempty"`
	Running   bool   `json:"running"`
}

type File struct {
	outputs.File
	URL string `json:"url"`
}

type Outputs struct {
	Pages   []pages.Page   `json:"pages"`
	Servers []Server       `json:"servers"`
	Links   []outputs.Link `json:"links"`
	Files   []File         `json:"files"`
}

func (c *Client) Outputs(sid string) (o Outputs, err error) {
	if err = c.do("GET", "/api/sessions/"+url.PathEscape(sid)+"/outputs", nil, &o); err != nil {
		return o, err
	}
	for i, f := range o.Files {
		o.Files[i].URL = c.URL + f.URL
	}
	return o, nil
}

func (c *Client) SessionUsage(sid string) (st usage.Stats, err error) {
	return st, c.do("GET", "/api/sessions/"+url.PathEscape(sid)+"/usage", nil, &st)
}

func (c *Client) Limits() (l usage.Limits, err error) {
	return l, c.do("GET", "/api/usage/limits", nil, &l)
}

func (c *Client) WeekRate() float64 {
	var r struct {
		Windows []struct {
			Key     string  `json:"key"`
			Percent float64 `json:"percent"`
			Cost    float64 `json:"cost"`
		} `json:"windows"`
	}
	if c.do("GET", "/api/usage/windows", nil, &r) != nil {
		return 0
	}
	for _, w := range r.Windows {
		if w.Key == "weekly_all" && w.Percent >= 1 {
			return w.Cost / w.Percent
		}
	}
	return 0
}

func (c *Client) Days(n int) ([]usage.Day, error) {
	var r struct{ Days []usage.Day }
	return r.Days, c.do("GET", fmt.Sprintf("/api/usage/report?days=%d", n), nil, &r)
}

// Ended is why a stopped session stopped, and the memory incident it was part of.
type Ended struct {
	Ending   *ends.Ending   `json:"ending"`
	Incident *ends.Incident `json:"incident"`
}

func (c *Client) Ended(sid string) (e Ended, err error) {
	return e, c.do("GET", "/api/sessions/"+url.PathEscape(sid)+"/ended", nil, &e)
}

func (c *Client) Incident(id, host string) (inc ends.Incident, err error) {
	path := "/api/resources/incidents/" + url.PathEscape(id)
	if host != "" {
		path += "?host=" + url.QueryEscape(host)
	}
	return inc, c.do("GET", path, nil, &inc)
}

func (c *Client) Incidents(host string) (list []ends.Incident, err error) {
	path := "/api/resources/incidents"
	if host != "" {
		path += "?host=" + url.QueryEscape(host)
	}
	return list, c.do("GET", path, nil, &list)
}

func (c *Client) Resources(host string) (r resources.Report, err error) {
	path := "/api/resources"
	if host != "" {
		path += "?host=" + url.QueryEscape(host)
	}
	return r, c.do("GET", path, nil, &r)
}
