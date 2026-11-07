from app.adult import is_adult
from app.release import pick_file


def test_porn_parodies_and_studios_are_adult():
    assert is_adult("The.Odyssey.XXX.Part.1.[Cosplayground.2026].XXX.WEB-DL.2160p.MP4-P2P", "The Odyssey")
    assert is_adult("Brazzers.24.05.12.Some.Name.1080p", "Some Film")
    assert is_adult("Avengers XXX An Axel Braun Parody 2012", "The Avengers")
    assert is_adult("Batman.v.Superman.A.Porn.Parody.mp4", "Batman v Superman: Dawn of Justice")


def test_real_films_are_not_adult():
    assert not is_adult("xXx State of the Union (2005) BDRemux 1080p", "xXx: State of the Union")  # its own title
    assert not is_adult("xXx.Return.of.Xander.Cage.2017.1080p", "xXx: Return of Xander Cage")
    assert not is_adult("Dreamcatcher.2003.1080p.BluRay.x265.10bit.5,1ch(xxxpav69).mkv", "Dreamcatcher")  # tag
    assert not is_adult("The.Odyssey.2026.2160p.WEB-DL.DDP5.1.Atmos.mkv", "The Odyssey")
    assert not is_adult("Hustlers.2019.1080p.BluRay", "Hustlers")
    assert not is_adult("The.Hustler.1961.1080p.BluRay", "The Hustler")


def test_adult_file_inside_a_pack_is_never_picked():
    G = 10**9
    files = [{"name": "Odyssey/The.Odyssey.XXX.Part.1.[Cosplayground.2026].mp4", "size": 9 * G},
             {"name": "Odyssey/The.Odyssey.2026.1080p.WEB-DL.mkv", "size": 5 * G}]
    assert pick_file(files, None, None, "The Odyssey", 2026)["name"].endswith("2026.1080p.WEB-DL.mkv")
    assert pick_file(files[:1], None, None, "The Odyssey", 2026) is None
