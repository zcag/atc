package client

import (
	"fmt"
	"net/url"

	"github.com/zcag/atc/internal/outputs"
	"github.com/zcag/atc/internal/pages"
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
	Pages    []pages.Page   `json:"pages"`
	Servers  []Server       `json:"servers"`
	Featured []outputs.Link `json:"featured"`
	Links    []outputs.Link `json:"links"`
	Files    []File         `json:"files"`
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

func (c *Client) Days(n int) ([]usage.Day, error) {
	var r struct{ Days []usage.Day }
	return r.Days, c.do("GET", fmt.Sprintf("/api/usage/report?days=%d", n), nil, &r)
}
