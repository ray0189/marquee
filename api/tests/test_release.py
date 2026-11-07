from app.release import is_blocked, parse, passes, pick_file, score

Q = {"blocked": ["cam", "ts", "tc", "scr", "r5", "workprint"], "min_resolution": 720, "browser_bias": 50, "prefer_hdr": False}


def test_remux_hdr_atmos():
    r = parse("Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FraMeSToR")
    assert (r.resolution, r.source, r.codec) == (2160, "remux", "hevc")
    assert r.hdr == ["HDR"] and "atmos" in r.audio


def test_webdl_ddp_and_container_from_filename():
    r = parse("Movie 2023 1080p", "Movie.2023.1080p.WEB-DL.DDP5.1.Atmos.H.264-GRP.mkv")
    assert (r.resolution, r.source, r.codec, r.container) == (1080, "web-dl", "avc", "mkv")
    assert "eac3" in r.audio and "atmos" in r.audio


def test_dolby_vision_and_hdr10plus():
    assert parse("Film.2160p.WEB-DL.DV.HDR10+.HEVC").hdr == ["DV", "HDR10+"]
    assert parse("Film.DVDRip.x264").hdr == []  # 'dv' inside DVDRip must not trigger


def test_cam_is_blocked_and_ts_extension_is_not_a_flag():
    assert is_blocked(parse("Movie.2024.HDCAM.x264"), Q)
    assert not is_blocked(parse("Show.S01E01.1080p.WEB-DL", "Show.S01E01.1080p.WEB-DL.ts"), Q)


def test_min_resolution_filter():
    assert not passes(parse("Movie.480p.DVDRip"), Q)
    assert passes(parse("Movie.720p.WEB-DL"), Q)
    assert passes(parse("Movie.WEB-DL"), Q)  # unknown resolution is allowed


def test_cached_always_outranks_uncached():
    best_uncached = score(parse("Movie.2160p.REMUX.HEVC"), seeders=5000, cached=False, owned=False, q=Q)
    worst_cached = score(parse("Movie.720p.HDTV"), seeders=0, cached=True, owned=False, q=Q)
    assert worst_cached > best_uncached


def test_mp4_avc_beats_mkv_hevc_when_bias_high():
    q = {**Q, "browser_bias": 100}
    mp4 = score(parse("Movie.1080p.WEB-DL.x264.AAC.mp4"), seeders=10, cached=True, owned=False, q=q)
    mkv = score(parse("Movie.1080p.WEB-DL.x265.DTS.mkv"), seeders=10, cached=True, owned=False, q=q)
    assert mp4 > mkv


def F(i, name, size):
    return {"id": i, "name": name, "size": size}


def test_pick_file_movie_largest_not_sample():
    files = [F(1, "Movie/sample.mkv", 99), F(2, "Movie/Movie.mkv", 5000), F(3, "Movie/Movie.nfo", 1)]
    assert pick_file(files)["id"] == 2


def test_sample_detection_uses_folder_or_tiny_size_not_the_title():
    # a show literally called "Sample Show" must not be filtered out
    files = [F(1, "Sample.Show.S01/Sample.Show.S01E01.mkv", 1000), F(2, "Sample.Show.S01/Sample.Show.S01E02.mkv", 1000)]
    assert pick_file(files, 1, 2)["id"] == 2
    # but real samples still are
    assert pick_file([F(1, "Movie/Sample/movie-sample.mkv", 500), F(2, "Movie/movie.mkv", 400)])["id"] == 2
    assert pick_file([F(1, "Movie/movie.sample.mkv", 50), F(2, "Movie/movie.mkv", 5000)])["id"] == 2


def test_pick_file_season_pack_matches_episode():
    files = [F(i, f"Show.S02/Show.S02E{i:02d}.1080p.mkv", 1000 + i) for i in range(1, 11)]
    assert pick_file(files, 2, 5)["id"] == 5
    assert pick_file(files, 2, 10)["id"] == 10  # E1 must not match E10
    assert pick_file(files, 2, 11) is None  # missing episode -> None, never a wrong file


def test_pick_file_multi_episode_and_nxm_styles():
    files = [F(1, "Show.S01E01E02.mkv", 10), F(2, "Show.S01E03.mkv", 10)]
    assert pick_file(files, 1, 2)["id"] == 1
    assert pick_file([F(1, "Show 3x07 Title.mkv", 10), F(2, "Show 3x08.mkv", 10)], 3, 8)["id"] == 2


def test_pick_file_single_file_fallback():
    assert pick_file([F(1, "Some.Episode.mkv", 10)], 1, 4)["id"] == 1


def test_film_pack_picks_the_right_film():
    G = 10**9
    pack = [
        {"name": "Marvel/01. Iron Man (2008).mkv", "size": 8 * G},
        {"name": "Marvel/06. The Avengers (2012).mkv", "size": 12 * G},
        {"name": "Marvel/11. Avengers Age of Ultron (2015).mkv", "size": 11 * G},
        {"name": "Marvel/23. Spider-Man No Way Home (2021).mkv", "size": 13 * G},
    ]
    assert pick_file(pack, None, None, "Avengers: Age of Ultron", 2015)["name"].endswith("Ultron (2015).mkv")
    assert pick_file(pack, None, None, "The Avengers", 2012)["name"].endswith("The Avengers (2012).mkv")
    assert pick_file(pack, None, None, "Iron Man 2", 2010) is None  # not in the pack: never play another film
    single = [{"name": "Vingadores.Era.de.Ultron.2015.mkv", "size": 9 * G}]
    assert pick_file(single, None, None, "Avengers: Age of Ultron", 2015) is single[0]  # one film: trust it


def test_3d_releases_are_always_blocked():
    q = {"blocked": []}
    assert is_blocked(parse("Avengers.Age.of.Ultron.2015.1080p.3D.HSBS.BluRay.x264", ""), q)
    assert is_blocked(parse("Movie.2020.Half-SBS.1080p", ""), q)
    assert not is_blocked(parse("Avengers.Age.of.Ultron.2015.1080p.BluRay.x264", ""), q)
